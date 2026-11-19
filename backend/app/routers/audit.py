from typing import Annotated

from fastapi import APIRouter, Query

from ..deps import OwnerCtx

router = APIRouter(tags=["audit"])


@router.get("/studio/audit")
def studio_audit(ctx: OwnerCtx, limit: Annotated[int, Query(ge=1, le=500)] = 100,
                 before_id: Annotated[int | None, Query(ge=1)] = None):
    rows = ctx.conn.execute(
        "select id, actor_id, action, target_type, target_id, data, created_at from audit_events "
        "where studio_id = %s and (%s::bigint is null or id < %s) order by id desc limit %s",
        (ctx.studio_id, before_id, before_id, limit)).fetchall()
    return {"events": rows}
