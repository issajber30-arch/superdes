import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, Request, Response
from pydantic import Field

from ..config import settings
from ..db import set_context
from ..deps import AnonCtx, MemberCtx, StaffCtx, UserCtx
from ..errors import ApiError, not_found, preview_closed
from ..schemas import Name, Register, Strict
from ..security import client_ip, limit, signup_limiter
from ..services import audit, credits
from ..services.geometry import Geometry
from ..services.plans import create_project
from .auth import create_user, me_payload, set_session_cookie

router = APIRouter(tags=["studios"])

Slug = Annotated[str, Field(pattern=r"^[a-z0-9-]{3,40}$")]
class StudioCreate(Strict):
    name: Name
    slug: Slug


class JoinStudio(Register):
    project_name: Name = "My project"
    geometry: Geometry | None = None





@router.post("/studios", status_code=201)
def create_studio(body: StudioCreate, ctx: UserCtx):
    if ctx.studio_id:
        raise ApiError(409, "already_in_studio", "this account already belongs to a studio")
    if ctx.conn.execute("select 1 from studio_public(%s)", (body.slug,)).fetchone():
        raise ApiError(409, "slug_taken", "this studio URL is taken")
    sid = uuid.uuid4()
    set_context(ctx.conn, ctx.user_id, sid)
    try:
        with ctx.conn.transaction():
            ctx.conn.execute("insert into studios (id, slug, name, owner_id) values (%s,%s,%s,%s)",
                             (sid, body.slug, body.name.strip(), ctx.user_id))
    except psycopg.errors.UniqueViolation:
        raise ApiError(409, "slug_taken", "this studio URL is taken")
    ctx.conn.execute("insert into studio_members (studio_id, user_id, role) values (%s,%s,'owner')", (sid, ctx.user_id))
    ctx.studio_id, ctx.role = sid, "owner"
    ctx.conn.execute("insert into studio_branding (studio_id, display_name) values (%s,%s)", (sid, body.name.strip()))
    ctx.conn.execute("insert into subscriptions (studio_id, plan_key, status, trial_ends_at) "
                     "values (%s,'trial','trial', now() + interval '14 days')", (sid,))
    credits.grant(ctx.conn, sid, ctx.user_id, settings.trial_credits, "trial_grant")
    audit.log(ctx.conn, "studio.create", sid, ctx.user_id, "studio", sid, {"slug": body.slug})
    return me_payload(ctx)


@router.get("/studio")
def get_studio(ctx: MemberCtx):
    studio = ctx.conn.execute("select id, slug, name, owner_id, created_at from studios where id = %s", (ctx.studio_id,)).fetchone()
    sub = ctx.conn.execute("select plan_key, status, trial_ends_at from subscriptions where studio_id = %s "
                           "order by created_at desc limit 1", (ctx.studio_id,)).fetchone()
    return {"studio": studio, "role": ctx.role, "subscription": sub,
            "credits": credits.balance(ctx.conn, ctx.studio_id) if ctx.is_staff else None}


@router.get("/studio/members")
def members(ctx: StaffCtx):
    return {"members": ctx.conn.execute(
        "select u.id, u.email, u.display_name, m.role, m.created_at from studio_members m join users u on u.id = m.user_id "
        "where m.studio_id = %s order by m.created_at", (ctx.studio_id,)).fetchall()}


# ---------- public (pre-auth) ----------
def _public_studio(ctx, slug: str) -> dict:
    row = ctx.conn.execute("select * from studio_public(%s)", (slug,)).fetchone()
    if not row:
        raise not_found("studio")
    return row


@router.post("/public/studios/{slug}/join", status_code=201)
def join_studio(slug: Slug, body: JoinStudio, ctx: AnonCtx, request: Request, response: Response):
    """Public studio link: creates a client account and a new project in that studio."""
    if settings.preview_mode:
        raise preview_closed()
    limit(signup_limiter, client_ip(request), "sign-ups")
    studio = _public_studio(ctx, slug)
    uid = create_user(ctx, body)
    set_context(ctx.conn, uid, studio["studio_id"])
    ctx.conn.execute("insert into studio_members (studio_id, user_id, role) values (%s,%s,'client')", (studio["studio_id"], uid))
    ctx.studio_id, ctx.role = studio["studio_id"], "client"
    audit.log(ctx.conn, "auth.register", ctx.studio_id, uid, "user", uid, {"via": "studio_link"})
    project = create_project(ctx, body.project_name.strip(), body.geometry.model_dump() if body.geometry else None)
    set_session_cookie(response, uid)
    return {**me_payload(ctx), "project": project}
