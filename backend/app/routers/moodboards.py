"""Moodboards, project image uploads and design alternatives."""
import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, File, UploadFile
from pydantic import Field

from ..config import settings
from ..deps import MemberCtx, get_project
from ..errors import ApiError, not_found
from ..schemas import Name, Strict
from ..services import plans, storage

router = APIRouter(tags=["moodboards"])


class MoodboardCreate(Strict):
    name: Name


class MoodboardItemCreate(Strict):
    kind: Literal["catalog", "finish", "upload", "color", "note"]
    ref: Annotated[str, Field(max_length=100)] = ""
    note: Annotated[str, Field(max_length=1000)] = ""
    position: Annotated[int, Field(ge=0, le=10000)] = 0


class AlternativeCreate(Strict):
    name: Name
    description: Annotated[str, Field(max_length=2000)] = ""
    style_key: Annotated[str, Field(max_length=40)] | None = None
    plan_version_no: Annotated[int, Field(ge=1)] | None = None


def _moodboard(ctx, project_id, moodboard_id):
    mb = ctx.conn.execute("select * from moodboards where id = %s and project_id = %s", (moodboard_id, project_id)).fetchone()
    if not mb:
        raise not_found("moodboard")
    return mb


@router.get("/projects/{project_id}/moodboards")
def list_moodboards(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"moodboards": ctx.conn.execute("select * from moodboards where project_id = %s order by created_at", (project_id,)).fetchall()}


@router.post("/projects/{project_id}/moodboards", status_code=201)
def create_moodboard(project_id: uuid.UUID, body: MoodboardCreate, ctx: MemberCtx):
    get_project(ctx, project_id)
    return ctx.conn.execute("insert into moodboards (studio_id, project_id, name, created_by) values (%s,%s,%s,%s) returning *",
                            (ctx.studio_id, project_id, body.name, ctx.user_id)).fetchone()


@router.get("/projects/{project_id}/moodboards/{moodboard_id}")
def get_moodboard(project_id: uuid.UUID, moodboard_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    mb = _moodboard(ctx, project_id, moodboard_id)
    items = ctx.conn.execute(
        "select i.*, c.name as catalog_name, f.name as finish_name, f.color as finish_color from moodboard_items i "
        "left join catalog_items c on i.kind = 'catalog' and c.key = i.ref "
        "left join finishes f on i.kind = 'finish' and f.key = i.ref "
        "where i.moodboard_id = %s order by i.position, i.created_at", (moodboard_id,)).fetchall()
    for it in items:
        if it["kind"] == "upload":
            it["image_url"] = f"/projects/{project_id}/uploads/{it['ref']}/content"
    return {**mb, "items": items}


@router.delete("/projects/{project_id}/moodboards/{moodboard_id}")
def delete_moodboard(project_id: uuid.UUID, moodboard_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    _moodboard(ctx, project_id, moodboard_id)
    ctx.conn.execute("delete from moodboards where id = %s", (moodboard_id,))
    return {"ok": True}


@router.post("/projects/{project_id}/moodboards/{moodboard_id}/items", status_code=201)
def add_item(project_id: uuid.UUID, moodboard_id: uuid.UUID, body: MoodboardItemCreate, ctx: MemberCtx):
    get_project(ctx, project_id)
    _moodboard(ctx, project_id, moodboard_id)
    checks = {
        "catalog": ("select 1 from catalog_items where key = %s", (body.ref,)),
        "finish": ("select 1 from finishes where key = %s", (body.ref,)),
    }
    if body.kind in checks and not ctx.conn.execute(*checks[body.kind]).fetchone():
        raise ApiError(422, "validation_error", f"unknown {body.kind} ref")
    if body.kind == "upload":
        try:
            ref_id = uuid.UUID(body.ref)
        except ValueError:
            raise ApiError(422, "validation_error", "upload ref must be an upload id")
        if not ctx.conn.execute("select 1 from uploads where id = %s and project_id = %s", (ref_id, project_id)).fetchone():
            raise ApiError(422, "validation_error", "upload not found in this project")
    if body.kind == "color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", body.ref):
        raise ApiError(422, "validation_error", "color ref must be #RRGGBB")
    return ctx.conn.execute(
        "insert into moodboard_items (studio_id, project_id, moodboard_id, kind, ref, note, position) "
        "values (%s,%s,%s,%s,%s,%s,%s) returning *",
        (ctx.studio_id, project_id, moodboard_id, body.kind, body.ref, body.note, body.position)).fetchone()


@router.delete("/projects/{project_id}/moodboards/{moodboard_id}/items/{item_id}")
def delete_item(project_id: uuid.UUID, moodboard_id: uuid.UUID, item_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    if not ctx.conn.execute("delete from moodboard_items where id = %s and moodboard_id = %s and project_id = %s returning id",
                            (item_id, moodboard_id, project_id)).fetchone():
        raise not_found("moodboard item")
    return {"ok": True}


# ---------- uploads ----------
@router.post("/projects/{project_id}/uploads", status_code=201)
def upload(project_id: uuid.UUID, ctx: MemberCtx, file: UploadFile = File(...)):
    get_project(ctx, project_id)
    data = file.file.read(settings.max_upload_bytes + 1)
    row = storage.store_image(ctx.conn, ctx.studio_id, project_id, ctx.user_id, data, "image", file.filename or "")
    return {**row, "url": f"/projects/{project_id}/uploads/{row['id']}/content"}


@router.get("/projects/{project_id}/uploads")
def list_uploads(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    rows = ctx.conn.execute("select id, kind, content_type, size_bytes, width, height, filename, created_at from uploads "
                            "where project_id = %s order by created_at desc", (project_id,)).fetchall()
    return {"uploads": [{**r, "url": f"/projects/{project_id}/uploads/{r['id']}/content"} for r in rows]}


@router.get("/projects/{project_id}/uploads/{upload_id}/content")
def upload_content(project_id: uuid.UUID, upload_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    row = ctx.conn.execute("select storage_key, content_type from uploads where id = %s and project_id = %s",
                           (upload_id, project_id)).fetchone()
    if not row:
        raise not_found("upload")
    return storage.image_response(row["storage_key"], row["content_type"])


# ---------- design alternatives ----------
@router.get("/projects/{project_id}/alternatives")
def list_alternatives(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"alternatives": ctx.conn.execute(
        "select a.*, v.version_no as plan_version_no from design_alternatives a join plan_versions v on v.id = a.plan_version_id "
        "where a.project_id = %s order by a.created_at", (project_id,)).fetchall()}


@router.post("/projects/{project_id}/alternatives", status_code=201)
def create_alternative(project_id: uuid.UUID, body: AlternativeCreate, ctx: MemberCtx):
    get_project(ctx, project_id)
    if body.style_key and not ctx.conn.execute("select 1 from styles where key = %s", (body.style_key,)).fetchone():
        raise ApiError(422, "validation_error", "unknown style_key")
    v = (plans.get_version(ctx.conn, project_id, body.plan_version_no, with_geometry=False) if body.plan_version_no
         else plans.current_version(ctx.conn, project_id, with_geometry=False))
    row = ctx.conn.execute(
        "insert into design_alternatives (studio_id, project_id, name, description, style_key, plan_version_id, created_by) "
        "values (%s,%s,%s,%s,%s,%s,%s) returning *",
        (ctx.studio_id, project_id, body.name, body.description, body.style_key, v["id"], ctx.user_id)).fetchone()
    return {**row, "plan_version_no": v["version_no"]}


@router.delete("/projects/{project_id}/alternatives/{alternative_id}")
def delete_alternative(project_id: uuid.UUID, alternative_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    if not ctx.conn.execute("delete from design_alternatives where id = %s and project_id = %s returning id",
                            (alternative_id, project_id)).fetchone():
        raise not_found("alternative")
    return {"ok": True}
