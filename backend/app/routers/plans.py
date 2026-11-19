import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import Field

from ..config import PROFESSIONAL_CAVEAT
from ..deps import MemberCtx, StaffCtx, get_project
from ..schemas import Strict
from ..services import audit, plans
from ..services.geometry import Geometry
from ..services.review_flags import compute_flags, diff

router = APIRouter(tags=["plans"])


class VersionCreate(Strict):
    geometry: Geometry
    label: Annotated[str, Field(max_length=200)] = ""
    base_version_no: Annotated[int, Field(ge=1)] | None = None


class ReviewMark(Strict):
    note: Annotated[str, Field(max_length=2000)] = ""


# ---------- plans ----------
def _version_out(v: dict) -> dict:
    return {**v, "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/plan")
def get_plan(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    plan = plans.get_plan(ctx.conn, project_id)
    return {"plan_id": plan["id"], "current_version": plans.current_version(ctx.conn, project_id), "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/plan/versions")
def list_versions(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    rows = ctx.conn.execute(f"select {plans.VERSION_COLS} from plan_versions where project_id = %s order by version_no desc",
                            (project_id,)).fetchall()
    return {"versions": rows, "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/plan/versions/{version_no}")
def get_version(project_id: uuid.UUID, version_no: int, ctx: MemberCtx):
    get_project(ctx, project_id)
    return _version_out(plans.get_version(ctx.conn, project_id, version_no))


@router.post("/projects/{project_id}/plan/versions", status_code=201)
def save_version(project_id: uuid.UUID, body: VersionCreate, ctx: MemberCtx):
    p = get_project(ctx, project_id)
    return _version_out(plans.save_version(ctx, p, body.geometry.model_dump(), body.label.strip(), body.base_version_no))


@router.get("/projects/{project_id}/plan/compare")
def compare(project_id: uuid.UUID, ctx: MemberCtx, from_: Annotated[int, Query(alias="from", ge=1)],
            to: Annotated[int, Query(ge=1)]):
    get_project(ctx, project_id)
    a = plans.get_version(ctx.conn, project_id, from_)
    b = plans.get_version(ctx.conn, project_id, to)
    return {"from": from_, "to": to, "diff": diff(a["geometry"], b["geometry"]),
            "flags": compute_flags(a["geometry"], b["geometry"]), "caveat": PROFESSIONAL_CAVEAT}


@router.post("/projects/{project_id}/plan/versions/{version_no}/review")
def mark_reviewed(project_id: uuid.UUID, version_no: int, body: ReviewMark, ctx: StaffCtx):
    """Designer acknowledges flagged changes. Status returns to 'conceptual' - never 'approved for construction'."""
    get_project(ctx, project_id)
    v = plans.get_version(ctx.conn, project_id, version_no, with_geometry=False)
    row = ctx.conn.execute(
        f"update plan_versions set review_status = 'conceptual', reviewed_by = %s, reviewed_at = now() where id = %s "
        f"returning {plans.VERSION_COLS}", (ctx.user_id, v["id"])).fetchone()
    ctx.conn.execute("insert into review_decisions (studio_id, project_id, plan_version_id, decision, note, decided_by, decided_role) "
                     "values (%s,%s,%s,'reviewed',%s,%s,%s)", (ctx.studio_id, project_id, v["id"], body.note, ctx.user_id, ctx.role))
    audit.log(ctx.conn, "review.decision", ctx.studio_id, ctx.user_id, "plan_version", v["id"],
              {"decision": "reviewed", "flags": len(v["review_flags"])})
    return _version_out(row)
