import uuid
from typing import Literal

from fastapi import APIRouter

from ..deps import MemberCtx, StaffCtx, get_project
from ..schemas import Name, Strict
from ..services import audit, plans
from ..services.geometry import Geometry

router = APIRouter(tags=["projects"])


class ProjectCreate(Strict):
    name: Name
    geometry: Geometry | None = None


class ProjectUpdate(Strict):
    name: Name | None = None
    status: Literal["active", "archived"] | None = None


@router.get("/projects")
def list_projects(ctx: MemberCtx):
    rows = ctx.conn.execute(
        "select p.id, p.name, p.status, p.created_at, v.version_no as current_version_no, v.review_status "
        "from projects p left join floor_plans f on f.project_id = p.id left join plan_versions v on v.id = f.current_version_id "
        "order by p.created_at desc").fetchall()
    return {"projects": rows}


@router.post("/projects", status_code=201)
def create(body: ProjectCreate, ctx: StaffCtx):
    return plans.create_project(ctx, body.name.strip(), body.geometry.model_dump() if body.geometry else None)


@router.get("/projects/{project_id}")
def get(project_id: uuid.UUID, ctx: MemberCtx):
    p = get_project(ctx, project_id)
    people = ctx.conn.execute(
        "select u.id, u.display_name, u.email, coalesce(pp.role, m.role) as role from users u "
        "join studio_members m on m.user_id = u.id "
        "left join project_permissions pp on pp.user_id = u.id and pp.project_id = %s "
        "where m.role in ('owner','designer') or pp.user_id is not null order by m.role", (project_id,)).fetchall()
    return {**p, "my_role": ctx.role, "people": people}


@router.patch("/projects/{project_id}")
def update(project_id: uuid.UUID, body: ProjectUpdate, ctx: StaffCtx):
    get_project(ctx, project_id)
    row = ctx.conn.execute("update projects set name = coalesce(%s, name), status = coalesce(%s, status) where id = %s returning *",
                           (body.name, body.status, project_id)).fetchone()
    audit.log(ctx.conn, "project.update", ctx.studio_id, ctx.user_id, "project", project_id, body.model_dump(exclude_none=True))
    return row
