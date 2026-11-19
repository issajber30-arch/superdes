from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

pool: ConnectionPool | None = None


def open_pool() -> ConnectionPool:
    global pool
    if pool is None:
        pool = ConnectionPool(settings.database_url, min_size=1, max_size=10, open=True,
                              kwargs={"row_factory": dict_row, "autocommit": True})
    return pool


def close_pool():
    global pool
    if pool is not None:
        pool.close()
        pool = None


def set_context(conn, user_id=None, studio_id=None):
    """Transaction-local tenant context consumed by RLS policies."""
    conn.execute("select set_config('app.user_id', %s, true), set_config('app.studio_id', %s, true)",
                 (str(user_id or ""), str(studio_id or "")))


@contextmanager
def tenant_tx(user_id=None, studio_id=None):
    with open_pool().connection() as conn, conn.transaction():
        set_context(conn, user_id, studio_id)
        yield conn
