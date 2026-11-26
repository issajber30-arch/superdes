import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Response
from psycopg.types.json import Jsonb
from pydantic import Field

from ..config import PROFESSIONAL_CAVEAT, settings
from ..deps import MemberCtx, get_project
from ..errors import ApiError, not_found
from ..schemas import Strict
from ..services import audit, credits, plans, storage
from ..services.geometry import BOUND

router = APIRouter(tags=["renders"])

ANGLES = ("front", "back", "left", "right", "corner-ne", "corner-nw", "corner-se", "corner-sw")


class Camera(Strict):
    """A 3D-view camera on the plan: position in plan mm and heading in degrees (0 = +x, 90 = +y / down the plan)."""
    x: Annotated[float, Field(ge=-BOUND, le=BOUND, allow_inf_nan=False)]
    y: Annotated[float, Field(ge=-BOUND, le=BOUND, allow_inf_nan=False)]
    yaw: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)]


class View(Strict):
    room_id: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    angle: Literal[ANGLES] = "front"
    style: Annotated[str, Field(max_length=40)] | None = None
    camera: Camera | None = None


class RenderRequest(Strict):
    view: View = Field(default_factory=View)
    plan_version_no: Annotated[int, Field(ge=1)] | None = None
    idempotency_key: Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")] | None = None


def job_out(project_id, j: dict) -> dict:
    return {"id": j["id"], "project_id": project_id, "plan_version_id": j["plan_version_id"], "plan_version_no": j["version_no"],
            "view": j["view"], "status": j["status"], "error": j["error"], "idempotency_key": j["idempotency_key"],
            "result_url": f"/projects/{project_id}/renders/{j['id']}/image" if j["result_upload_id"] else None,
            "created_at": j["created_at"], "started_at": j["started_at"], "finished_at": j["finished_at"],
            "label": "Conceptual visualization", "caveat": PROFESSIONAL_CAVEAT}


JOB_SQL = "select j.*, v.version_no from render_jobs j join plan_versions v on v.id = j.plan_version_id "


@router.post("/projects/{project_id}/renders", status_code=202)
def request_render(project_id: uuid.UUID, body: RenderRequest, ctx: MemberCtx, response: Response):
    get_project(ctx, project_id)
    conn = ctx.conn
    key = body.idempotency_key or str(uuid.uuid4())
    credits.lock_studio(conn, ctx.studio_id)
    existing = conn.execute(JOB_SQL + "where j.project_id = %s and j.idempotency_key = %s", (project_id, key)).fetchone()
    if existing:
        response.status_code = 200  # idempotent replay: no new job, no new debit
        return {**job_out(project_id, existing), "replayed": True}
    if not ctx.is_staff:  # clients get a small per-project quota; failed (refunded) jobs don't count
        used = conn.execute("select count(*) as n from render_jobs where project_id = %s and requested_by = %s "
                            "and status <> 'failed'", (project_id, ctx.user_id)).fetchone()["n"]
        if used >= settings.render_client_quota:
            raise ApiError(429, "render_quota_exceeded", "client render quota for this project reached; ask your designer")
    v = (plans.get_version(conn, project_id, body.plan_version_no) if body.plan_version_no
         else plans.current_version(conn, project_id))
    if body.view.camera and not body.view.room_id:
        raise ApiError(422, "validation_error", "view.room_id is required with view.camera")
    if body.view.room_id and not any(r["id"] == body.view.room_id for r in v["geometry"]["rooms"]):
        raise ApiError(422, "validation_error", "view.room_id is not a room in that plan version")
    if body.view.style and not conn.execute("select 1 from styles where key = %s", (body.view.style,)).fetchone():
        raise ApiError(422, "validation_error", "unknown view.style")
    job_id = uuid.uuid4()
    ledger_id = credits.debit_for_render(conn, ctx.studio_id, ctx.user_id, job_id)  # 402 when insufficient
    conn.execute("insert into render_jobs (id, studio_id, project_id, plan_version_id, view, idempotency_key, ledger_id, requested_by) "
                 "values (%s,%s,%s,%s,%s,%s,%s,%s)",
                 (job_id, ctx.studio_id, project_id, v["id"], Jsonb(body.view.model_dump()), key, ledger_id, ctx.user_id))
    audit.log(conn, "render.request", ctx.studio_id, ctx.user_id, "render_job", job_id,
              {"project_id": str(project_id), "plan_version_no": v["version_no"]})
    return {**job_out(project_id, conn.execute(JOB_SQL + "where j.id = %s", (job_id,)).fetchone()), "replayed": False}


@router.get("/projects/{project_id}/renders")
def list_renders(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    rows = ctx.conn.execute(JOB_SQL + "where j.project_id = %s order by j.created_at desc", (project_id,)).fetchall()
    return {"renders": [job_out(project_id, r) for r in rows], "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/renders/{render_id}")
def get_render(project_id: uuid.UUID, render_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    j = ctx.conn.execute(JOB_SQL + "where j.id = %s and j.project_id = %s", (render_id, project_id)).fetchone()
    if not j:
        raise not_found("render")
    return job_out(project_id, j)


@router.get("/projects/{project_id}/renders/{render_id}/image")
def render_image(project_id: uuid.UUID, render_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    row = ctx.conn.execute("select u.storage_key, u.content_type from render_jobs j join uploads u on u.id = j.result_upload_id "
                           "where j.id = %s and j.project_id = %s", (render_id, project_id)).fetchone()
    if not row:
        raise not_found("render image")
    return storage.image_response(row["storage_key"], row["content_type"])
