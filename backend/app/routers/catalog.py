import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import Field

from ..config import ESTIMATE_BASIS
from ..deps import AnonCtx, MemberCtx, get_project
from ..errors import ApiError, not_found
from ..schemas import Strict

router = APIRouter(tags=["catalog"])


class FinishSelect(Strict):
    room_id: Annotated[str, Field(min_length=1, max_length=64)]
    surface: Literal["floor", "wall"]
    finish_key: Annotated[str, Field(min_length=1, max_length=64)]


@router.get("/catalog/furniture")
def furniture(ctx: AnonCtx, category: Annotated[str | None, Query(max_length=40)] = None,
              room_kind: Annotated[str | None, Query(max_length=40)] = None):
    rows = ctx.conn.execute(
        "select * from catalog_items where (%s::text is null or category = %s) and (%s::text is null or %s = any(room_kinds)) "
        "order by category, name", (category, category, room_kind, room_kind)).fetchall()
    return {"items": rows, "basis": ESTIMATE_BASIS}


@router.get("/catalog/finishes")
def finishes(ctx: AnonCtx, surface: Annotated[Literal["floor", "wall"] | None, Query()] = None):
    rows = ctx.conn.execute("select * from finishes where (%s::text is null or surface = %s) order by surface, name",
                            (surface, surface)).fetchall()
    return {"finishes": rows, "basis": ESTIMATE_BASIS}


@router.get("/catalog/styles")
def styles(ctx: AnonCtx):
    return {"styles": ctx.conn.execute("select * from styles order by name").fetchall()}


@router.get("/projects/{project_id}/finishes")
def list_selections(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return {"selections": ctx.conn.execute(
        "select s.id, s.room_id, s.surface, s.finish_key, f.name, f.color from finish_selections s "
        "join finishes f on f.key = s.finish_key where s.project_id = %s order by s.room_id, s.surface", (project_id,)).fetchall()}


@router.put("/projects/{project_id}/finishes")
def select_finish(project_id: uuid.UUID, body: FinishSelect, ctx: MemberCtx):
    get_project(ctx, project_id)
    f = ctx.conn.execute("select surface from finishes where key = %s", (body.finish_key,)).fetchone()
    if not f:
        raise ApiError(422, "validation_error", "unknown finish_key")
    if f["surface"] != body.surface:
        raise ApiError(422, "validation_error", f"finish is for surface '{f['surface']}'")
    return ctx.conn.execute(
        "insert into finish_selections (studio_id, project_id, room_id, surface, finish_key) values (%s,%s,%s,%s,%s) "
        "on conflict (project_id, room_id, surface) do update set finish_key = excluded.finish_key "
        "returning id, room_id, surface, finish_key", (ctx.studio_id, project_id, body.room_id, body.surface, body.finish_key)).fetchone()


@router.delete("/projects/{project_id}/finishes/{selection_id}")
def delete_selection(project_id: uuid.UUID, selection_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    if not ctx.conn.execute("delete from finish_selections where id = %s and project_id = %s returning id",
                            (selection_id, project_id)).fetchone():
        raise not_found("finish selection")
    return {"ok": True}
