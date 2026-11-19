import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Request
from psycopg.types.json import Jsonb
from pydantic import Field

from ..deps import MemberCtx, _member, get_project, request_user_id, user_tx
from ..errors import not_found
from ..schemas import Strict
from ..security import ai_limiter, limit
from ..services.ai.consultant import build_context, get_consultant

router = APIRouter(tags=["ai"])
MSG_COLS = "id, conversation_id, role, content, suggestions, provider, author_id, created_at"


class ChatIn(Strict):
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    conversation_id: uuid.UUID | None = None


class Feedback(Strict):
    decision: Literal["accept", "reject"]


@router.post("/projects/{project_id}/ai/messages", status_code=201)
def chat(project_id: uuid.UUID, body: ChatIn, request: Request):
    # Manages its own transactions so no DB connection is held during the (slow) consultant call.
    uid = request_user_id(request)
    with user_tx(uid) as ctx:
        _member(ctx)
        limit(ai_limiter, str(uid), "AI messages")
        project = get_project(ctx, project_id)
        conn = ctx.conn
        if body.conversation_id:
            conv = conn.execute("select id from ai_conversations where id = %s and project_id = %s",
                                (body.conversation_id, project_id)).fetchone()
            if not conv:
                raise not_found("conversation")
        else:
            conv = conn.execute("insert into ai_conversations (studio_id, project_id, created_by) values (%s,%s,%s) returning id",
                                (ctx.studio_id, project_id, ctx.user_id)).fetchone()
        history = conn.execute("select role, content from ai_messages where conversation_id = %s order by created_at",
                               (conv["id"],)).fetchall()
        user_msg = conn.execute(
            f"insert into ai_messages (studio_id, project_id, conversation_id, role, content, author_id) values (%s,%s,%s,'user',%s,%s) "
            f"returning {MSG_COLS}", (ctx.studio_id, project_id, conv["id"], body.message, ctx.user_id)).fetchone()
        context = build_context(conn, project, history)
    consultant = get_consultant()
    result = consultant.advise(context, body.message)
    suggestions = [{**s, "id": str(uuid.uuid4()), "applied": False} for s in result["suggestions"]]
    provider = "rules" if result.get("provider_fallback") else consultant.name
    with user_tx(uid) as ctx:
        _member(ctx)
        get_project(ctx, project_id)  # access may have been revoked meanwhile
        reply = ctx.conn.execute(
            f"insert into ai_messages (studio_id, project_id, conversation_id, role, content, suggestions, provider) "
            f"values (%s,%s,%s,'assistant',%s,%s,%s) returning {MSG_COLS}",
            (ctx.studio_id, project_id, conv["id"], result["message"], Jsonb(suggestions), provider)).fetchone()
    return {"conversation_id": conv["id"], "user_message": user_msg, "message": reply,
            "note": "Suggestions are advisory and are never applied to your plan automatically."}


@router.get("/projects/{project_id}/ai/conversations")
def conversations(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"conversations": ctx.conn.execute(
        "select c.id, c.created_by, c.created_at, (select count(*) from ai_messages m where m.conversation_id = c.id) as message_count "
        "from ai_conversations c where c.project_id = %s order by c.created_at desc", (project_id,)).fetchall()}


@router.get("/projects/{project_id}/ai/conversations/{conversation_id}/messages")
def messages(project_id: uuid.UUID, conversation_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    rows = ctx.conn.execute(f"select {MSG_COLS} from ai_messages where conversation_id = %s and project_id = %s order by created_at",
                            (conversation_id, project_id)).fetchall()
    if not rows and not ctx.conn.execute("select 1 from ai_conversations where id = %s and project_id = %s",
                                         (conversation_id, project_id)).fetchone():
        raise not_found("conversation")
    return {"messages": rows}


@router.post("/projects/{project_id}/ai/suggestions/{suggestion_id}/feedback")
def feedback(project_id: uuid.UUID, suggestion_id: Annotated[str, Path(max_length=64)], body: Feedback, ctx: MemberCtx):
    """Records accept/reject as a preference for future advice. Never applies anything to the plan."""
    get_project(ctx, project_id)
    s = ctx.conn.execute("select s.value as s from ai_messages m, jsonb_array_elements(m.suggestions) s "
                         "where m.project_id = %s and s.value->>'id' = %s", (project_id, suggestion_id)).fetchone()
    if not s:
        raise not_found("suggestion")
    s = s["s"]
    row = ctx.conn.execute(
        "insert into ai_preferences (studio_id, project_id, user_id, suggestion_id, kind, key, decision) values (%s,%s,%s,%s,%s,%s,%s) "
        "on conflict (project_id, user_id, suggestion_id) do update set decision = excluded.decision, created_at = now() "
        "returning suggestion_id, kind, key, decision, created_at",
        (ctx.studio_id, project_id, ctx.user_id, suggestion_id, s["kind"], s["key"], body.decision)).fetchone()
    return row


@router.get("/projects/{project_id}/ai/preferences")
def preferences(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"preferences": ctx.conn.execute("select suggestion_id, kind, key, decision, user_id, created_at from ai_preferences "
                                            "where project_id = %s order by created_at", (project_id,)).fetchall()}
