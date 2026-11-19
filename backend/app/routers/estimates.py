import uuid
from typing import Annotated

from fastapi import APIRouter, Path
from pydantic import Field

from ..config import ESTIMATE_BASIS, ESTIMATE_DISCLAIMER
from ..deps import MemberCtx, get_project
from ..errors import ApiError, not_found
from ..schemas import Name, Strict
from ..services.estimates import compute

router = APIRouter(tags=["estimates"])

Money = Annotated[float, Field(ge=0, le=10_000_000, allow_inf_nan=False)]
Qty = Annotated[float, Field(ge=0, le=100_000, allow_inf_nan=False)]
ItemKey = Annotated[str, Path(pattern=r"^(furn|finish):[A-Za-z0-9_.:-]{1,140}$")]


class OverrideBody(Strict):
    label: Annotated[str, Field(max_length=200)] | None = None
    qty: Qty | None = None
    unit_low: Money | None = None
    unit_high: Money | None = None
    excluded: bool = False


class ManualItem(Strict):
    label: Name
    qty: Qty = 1
    unit: Annotated[str, Field(min_length=1, max_length=10)] = "pcs"
    unit_low: Money = 0
    unit_high: Money = 0


@router.get("/projects/{project_id}/estimates")
def get_estimates(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    return compute(ctx.conn, project_id)


@router.put("/projects/{project_id}/estimates/overrides/{item_key}")
def put_override(project_id: uuid.UUID, item_key: ItemKey, body: OverrideBody, ctx: MemberCtx):
    get_project(ctx, project_id)
    if body.unit_low is not None and body.unit_high is not None and body.unit_low > body.unit_high:
        raise ApiError(422, "validation_error", "unit_low must be <= unit_high")
    ctx.conn.execute(
        "insert into estimate_items (studio_id, project_id, source, item_key, label, qty, unit_low, unit_high, excluded, updated_by) "
        "values (%s,%s,'override',%s,%s,%s,%s,%s,%s,%s) on conflict (project_id, item_key) do update set "
        "label = excluded.label, qty = excluded.qty, unit_low = excluded.unit_low, unit_high = excluded.unit_high, "
        "excluded = excluded.excluded, updated_by = excluded.updated_by, updated_at = now()",
        (ctx.studio_id, project_id, item_key, body.label or "", body.qty, body.unit_low, body.unit_high, body.excluded, ctx.user_id))
    return compute(ctx.conn, project_id)


@router.delete("/projects/{project_id}/estimates/overrides/{item_key}")
def delete_override(project_id: uuid.UUID, item_key: ItemKey, ctx: MemberCtx):
    get_project(ctx, project_id)
    ctx.conn.execute("delete from estimate_items where project_id = %s and item_key = %s and source = 'override'", (project_id, item_key))
    return compute(ctx.conn, project_id)


@router.post("/projects/{project_id}/estimates/items", status_code=201)
def add_manual(project_id: uuid.UUID, body: ManualItem, ctx: MemberCtx):
    get_project(ctx, project_id)
    if body.unit_low > body.unit_high:
        raise ApiError(422, "validation_error", "unit_low must be <= unit_high")
    ctx.conn.execute(
        "insert into estimate_items (studio_id, project_id, source, item_key, label, qty, unit, unit_low, unit_high, updated_by) "
        "values (%s,%s,'manual',%s,%s,%s,%s,%s,%s,%s)",
        (ctx.studio_id, project_id, f"manual:{uuid.uuid4()}", body.label, body.qty, body.unit, body.unit_low, body.unit_high, ctx.user_id))
    return compute(ctx.conn, project_id)


@router.delete("/projects/{project_id}/estimates/items/{item_id}")
def delete_manual(project_id: uuid.UUID, item_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    if not ctx.conn.execute("delete from estimate_items where id = %s and project_id = %s and source = 'manual' returning id",
                            (item_id, project_id)).fetchone():
        raise not_found("estimate item")
    return compute(ctx.conn, project_id)


@router.get("/projects/{project_id}/shopping-list")
def shopping_list(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    est = compute(ctx.conn, project_id)
    lines = [{k: it[k] for k in ("item_key", "label", "category", "qty", "unit", "unit_low", "unit_high", "total_low",
                                 "total_high", "rooms")} for it in est["items"] if not it["excluded"]]
    return {"items": lines, "totals": est["totals"], "currency": est["currency"], "plan_version_no": est["plan_version_no"],
            "retailer": None, "basis": ESTIMATE_BASIS, "non_binding": True, "label": "Estimate - non-binding",
            "disclaimer": ESTIMATE_DISCLAIMER}
