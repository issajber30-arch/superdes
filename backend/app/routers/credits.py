from fastapi import APIRouter

from ..deps import AnonCtx, StaffCtx
from ..services import credits

router = APIRouter(tags=["credits"])


@router.get("/studio/credits")
def studio_credits(ctx: StaffCtx):
    ledger = ctx.conn.execute("select id, delta, reason, render_job_id, created_by, created_at from credit_ledger "
                              "where studio_id = %s order by created_at desc limit 200", (ctx.studio_id,)).fetchall()
    return {"balance": credits.balance(ctx.conn, ctx.studio_id), "ledger": ledger}


@router.get("/plans")
def subscription_plans(ctx: AnonCtx):
    return {"plans": ctx.conn.execute("select * from plans order by monthly_credits").fetchall()}
