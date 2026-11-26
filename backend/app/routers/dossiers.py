import uuid
from typing import Annotated

from fastapi import APIRouter, Response
from pydantic import Field

from ..config import PROFESSIONAL_CAVEAT
from ..deps import MemberCtx, StaffCtx, get_project
from ..errors import not_found
from ..schemas import Strict
from ..services import audit, plans
from ..services.dossier import CSP, build_html, view_images

router = APIRouter(tags=["dossiers"])


class DossierIn(Strict):
    plan_version_no: Annotated[int, Field(ge=1)] | None = None
    note: Annotated[str, Field(max_length=2000)] = ""
    views: Annotated[list[Annotated[str, Field(max_length=3_000_000)]], Field(max_length=4)] = []  # 3D snapshots (data URLs)


LIST_SQL = ("select d.id, v.version_no as plan_version_no, v.review_status, d.note, d.created_by, d.created_at "
            "from design_dossiers d join plan_versions v on v.id = d.plan_version_id ")


@router.post("/projects/{project_id}/dossiers", status_code=201)
def submit(project_id: uuid.UUID, body: DossierIn, ctx: StaffCtx):
    p = get_project(ctx, project_id)
    v = plans.get_version(ctx.conn, project_id, body.plan_version_no) if body.plan_version_no else plans.current_version(ctx.conn, project_id)
    views = view_images(body.views)  # validated + re-encoded before anything is written
    author = ctx.conn.execute("select display_name, email from users where id = %s", (ctx.user_id,)).fetchone()
    html = build_html(ctx.conn, ctx.studio_id, p, v, body.note, author, views)
    row = ctx.conn.execute("insert into design_dossiers (studio_id, project_id, plan_version_id, html, note, created_by) "
                           "values (%s,%s,%s,%s,%s,%s) returning id", (ctx.studio_id, project_id, v["id"], html, body.note, ctx.user_id)).fetchone()
    audit.log(ctx.conn, "dossier.submit", ctx.studio_id, ctx.user_id, "dossier", row["id"], {"plan_version_no": v["version_no"]})
    out = ctx.conn.execute(LIST_SQL + "where d.id = %s", (row["id"],)).fetchone()
    return {**out, "html_url": f"/projects/{project_id}/dossiers/{row['id']}", "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/dossiers")
def list_dossiers(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    rows = ctx.conn.execute(LIST_SQL + "where d.project_id = %s order by d.created_at desc", (project_id,)).fetchall()
    return {"dossiers": [{**r, "html_url": f"/projects/{project_id}/dossiers/{r['id']}"} for r in rows], "caveat": PROFESSIONAL_CAVEAT}


@router.get("/projects/{project_id}/dossiers/{dossier_id}")
def get_dossier(project_id: uuid.UUID, dossier_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    row = ctx.conn.execute("select html from design_dossiers where id = %s and project_id = %s", (dossier_id, project_id)).fetchone()
    if not row:
        raise not_found("dossier")
    return Response(row["html"], media_type="text/html; charset=utf-8", headers={
        "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store", "X-Professional-Caveat": "conceptual-only-not-for-construction"})
