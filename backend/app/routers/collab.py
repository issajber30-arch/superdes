"""Review comments, review decisions, project tasks and designer<->client messages."""
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import Field

from ..deps import MemberCtx, StaffCtx, get_project
from ..errors import ApiError, not_found
from ..schemas import Strict
from ..services import audit, plans

router = APIRouter(tags=["collaboration"])
Body = Annotated[str, Field(min_length=1, max_length=5000)]
ELEMENT_CATS = ("walls", "openings", "rooms", "fixtures", "furniture")


class CommentIn(Strict):
    body: Body
    plan_version_no: Annotated[int, Field(ge=1)] | None = None
    element_id: Annotated[str, Field(min_length=1, max_length=64)] | None = None


class DecisionIn(Strict):
    plan_version_no: Annotated[int, Field(ge=1)]
    decision: Literal["concept_approved", "changes_requested"]
    note: Annotated[str, Field(max_length=2000)] = ""


class TaskIn(Strict):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    assignee_id: uuid.UUID | None = None
    status: Literal["todo", "doing", "done"] = "todo"


class TaskPatch(Strict):
    title: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    assignee_id: uuid.UUID | None = None
    status: Literal["todo", "doing", "done"] | None = None


class MessageIn(Strict):
    body: Body


def _check_assignee(ctx, project_id, uid):
    ok = ctx.conn.execute(
        "select 1 from studio_members m left join project_permissions pp on pp.user_id = m.user_id and pp.project_id = %s "
        "where m.user_id = %s and m.studio_id = %s and (m.role in ('owner','designer') or pp.user_id is not null)",
        (project_id, uid, ctx.studio_id)).fetchone()
    if not ok:
        raise ApiError(422, "validation_error", "assignee has no access to this project")


# ---------- comments ----------
@router.get("/projects/{project_id}/comments")
def list_comments(project_id: uuid.UUID, ctx: MemberCtx, plan_version_no: Annotated[int | None, Query(ge=1)] = None):
    get_project(ctx, project_id)
    return {"comments": ctx.conn.execute(
        "select c.id, c.body, c.element_id, c.author_id, u.display_name as author_name, v.version_no as plan_version_no, c.created_at "
        "from review_comments c left join plan_versions v on v.id = c.plan_version_id left join users u on u.id = c.author_id "
        "where c.project_id = %s and (%s::int is null or v.version_no = %s) order by c.created_at",
        (project_id, plan_version_no, plan_version_no)).fetchall()}


@router.post("/projects/{project_id}/comments", status_code=201)
def add_comment(project_id: uuid.UUID, body: CommentIn, ctx: MemberCtx):
    get_project(ctx, project_id)
    v = plans.get_version(ctx.conn, project_id, body.plan_version_no) if body.plan_version_no else plans.current_version(ctx.conn, project_id)
    if body.element_id and not any(e["id"] == body.element_id for c in ELEMENT_CATS for e in v["geometry"][c]):
        raise ApiError(422, "validation_error", "element_id not found in that plan version")
    row = ctx.conn.execute(
        "insert into review_comments (studio_id, project_id, plan_version_id, element_id, author_id, body) values (%s,%s,%s,%s,%s,%s) "
        "returning id, body, element_id, author_id, created_at",
        (ctx.studio_id, project_id, v["id"], body.element_id, ctx.user_id, body.body)).fetchone()
    return {**row, "plan_version_no": v["version_no"]}


# ---------- decisions ----------
@router.get("/projects/{project_id}/decisions")
def list_decisions(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"decisions": ctx.conn.execute(
        "select d.id, v.version_no as plan_version_no, d.decision, d.note, d.decided_by, d.decided_role, d.created_at "
        "from review_decisions d join plan_versions v on v.id = d.plan_version_id where d.project_id = %s order by d.created_at",
        (project_id,)).fetchall()}


@router.post("/projects/{project_id}/decisions", status_code=201)
def add_decision(project_id: uuid.UUID, body: DecisionIn, ctx: MemberCtx):
    """A concept decision (client or designer). It is never an approval for construction."""
    get_project(ctx, project_id)
    v = plans.get_version(ctx.conn, project_id, body.plan_version_no, with_geometry=False)
    row = ctx.conn.execute(
        "insert into review_decisions (studio_id, project_id, plan_version_id, decision, note, decided_by, decided_role) "
        "values (%s,%s,%s,%s,%s,%s,%s) returning id, decision, note, decided_by, decided_role, created_at",
        (ctx.studio_id, project_id, v["id"], body.decision, body.note, ctx.user_id, ctx.role)).fetchone()
    audit.log(ctx.conn, "review.decision", ctx.studio_id, ctx.user_id, "plan_version", v["id"], {"decision": body.decision})
    return {**row, "plan_version_no": v["version_no"]}


# ---------- tasks ----------
TASK_COLS = "id, title, assignee_id, status, created_by, created_at, updated_at"


@router.get("/projects/{project_id}/tasks")
def list_tasks(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"tasks": ctx.conn.execute(f"select {TASK_COLS} from project_tasks where project_id = %s order by created_at",
                                      (project_id,)).fetchall()}


@router.post("/projects/{project_id}/tasks", status_code=201)
def add_task(project_id: uuid.UUID, body: TaskIn, ctx: MemberCtx):
    get_project(ctx, project_id)
    if body.assignee_id:
        _check_assignee(ctx, project_id, body.assignee_id)
    return ctx.conn.execute(
        f"insert into project_tasks (studio_id, project_id, title, assignee_id, status, created_by) values (%s,%s,%s,%s,%s,%s) "
        f"returning {TASK_COLS}", (ctx.studio_id, project_id, body.title, body.assignee_id, body.status, ctx.user_id)).fetchone()


@router.patch("/projects/{project_id}/tasks/{task_id}")
def update_task(project_id: uuid.UUID, task_id: uuid.UUID, body: TaskPatch, ctx: MemberCtx):
    get_project(ctx, project_id)
    task = ctx.conn.execute("select * from project_tasks where id = %s and project_id = %s", (task_id, project_id)).fetchone()
    if not task:
        raise not_found("task")
    changes = body.model_dump(exclude_unset=True)
    if "assignee_id" in changes and changes["assignee_id"]:
        _check_assignee(ctx, project_id, changes["assignee_id"])
    merged = {k: changes.get(k, task[k]) for k in ("title", "assignee_id", "status")}
    if merged["title"] is None or merged["status"] is None:
        raise ApiError(422, "validation_error", "title and status cannot be null")
    return ctx.conn.execute(f"update project_tasks set title = %s, assignee_id = %s, status = %s, updated_at = now() "
                            f"where id = %s returning {TASK_COLS}",
                            (merged["title"], merged["assignee_id"], merged["status"], task_id)).fetchone()


@router.delete("/projects/{project_id}/tasks/{task_id}")
def delete_task(project_id: uuid.UUID, task_id: uuid.UUID, ctx: StaffCtx):
    get_project(ctx, project_id)
    if not ctx.conn.execute("delete from project_tasks where id = %s and project_id = %s returning id", (task_id, project_id)).fetchone():
        raise not_found("task")
    return {"ok": True}


# ---------- messages ----------
@router.get("/projects/{project_id}/messages")
def list_messages(project_id: uuid.UUID, ctx: MemberCtx, after: Annotated[datetime | None, Query()] = None):
    get_project(ctx, project_id)
    return {"messages": ctx.conn.execute(
        "select m.id, m.author_id, u.display_name as author_name, m.body, m.created_at from project_messages m "
        "left join users u on u.id = m.author_id where m.project_id = %s and (%s::timestamptz is null or m.created_at > %s) "
        "order by m.created_at limit 500", (project_id, after, after)).fetchall()}


@router.post("/projects/{project_id}/messages", status_code=201)
def add_message(project_id: uuid.UUID, body: MessageIn, ctx: MemberCtx):
    get_project(ctx, project_id)
    return ctx.conn.execute("insert into project_messages (studio_id, project_id, author_id, body) values (%s,%s,%s,%s) "
                            "returning id, author_id, body, created_at", (ctx.studio_id, project_id, ctx.user_id, body.body)).fetchone()
