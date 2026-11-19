from ..errors import ApiError
from . import audit


def lock_studio(conn, studio_id):
    """Serialize credit movements per studio within the current transaction."""
    conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 7))", (str(studio_id),))


def balance(conn, studio_id) -> int:
    return conn.execute("select coalesce(sum(delta), 0)::int as b from credit_ledger where studio_id = %s",
                        (studio_id,)).fetchone()["b"]


def grant(conn, studio_id, user_id, amount: int, reason: str):
    row = conn.execute("insert into credit_ledger (studio_id, delta, reason, created_by) values (%s,%s,%s,%s) returning id",
                       (studio_id, amount, reason, user_id)).fetchone()
    audit.log(conn, "credits.grant", studio_id, user_id, "credit_ledger", row["id"], {"delta": amount, "reason": reason})


def debit_for_render(conn, studio_id, user_id, job_id) -> str:
    lock_studio(conn, studio_id)
    if balance(conn, studio_id) < 1:
        raise ApiError(402, "insufficient_credits", "not enough render credits")
    row = conn.execute(
        "insert into credit_ledger (studio_id, delta, reason, render_job_id, created_by) values (%s,-1,'render',%s,%s) returning id",
        (studio_id, job_id, user_id)).fetchone()
    audit.log(conn, "credits.debit", studio_id, user_id, "render_job", job_id, {"delta": -1})
    return row["id"]


def refund_render(conn, studio_id, user_id, job_id):
    lock_studio(conn, studio_id)
    already = conn.execute("select 1 from credit_ledger where render_job_id = %s and reason = 'render_refund'", (job_id,)).fetchone()
    if already:
        return
    conn.execute("insert into credit_ledger (studio_id, delta, reason, render_job_id, created_by) values (%s,1,'render_refund',%s,%s)",
                 (studio_id, job_id, user_id))
    audit.log(conn, "credits.refund", studio_id, user_id, "render_job", job_id, {"delta": 1})
