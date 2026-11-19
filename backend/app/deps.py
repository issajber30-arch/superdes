"""Request auth + tenant context. Every authenticated request runs in ONE transaction with
app.user_id / app.studio_id set (transaction-local) so RLS applies to every query."""
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request

from .config import settings
from .db import set_context, tenant_tx
from .errors import ApiError, forbidden, not_found
from .security import decode_token


@dataclass
class Ctx:
    conn: object
    user_id: uuid.UUID | None
    studio_id: uuid.UUID | None = None
    role: str | None = None  # owner | designer | client | None (no studio yet)

    @property
    def is_staff(self) -> bool:
        return self.role in ("owner", "designer")


def session_user_id(request: Request) -> uuid.UUID | None:
    token = request.cookies.get(settings.cookie_name)
    return decode_token(token) if token else None


def load_membership(ctx: Ctx):
    row = ctx.conn.execute("select studio_id, role from studio_members where user_id = %s", (ctx.user_id,)).fetchone()
    if row:
        ctx.studio_id, ctx.role = row["studio_id"], row["role"]
        set_context(ctx.conn, ctx.user_id, ctx.studio_id)


def _anon(request: Request):
    with tenant_tx() as conn:
        yield Ctx(conn=conn, user_id=None)


def request_user_id(request: Request) -> uuid.UUID:
    uid = session_user_id(request)
    if uid is None:
        raise ApiError(401, "unauthenticated", "login required")
    return uid


@contextmanager
def user_tx(uid: uuid.UUID):
    """One tenant transaction for an existing user (membership loaded)."""
    with tenant_tx(uid) as conn:
        ctx = Ctx(conn=conn, user_id=uid)
        if not conn.execute("select 1 from users where id = %s", (uid,)).fetchone():
            raise ApiError(401, "unauthenticated", "login required")
        load_membership(ctx)
        yield ctx


def _user(request: Request):
    with user_tx(request_user_id(request)) as ctx:
        yield ctx


def _member(ctx: Annotated[Ctx, Depends(_user, scope="function")]) -> Ctx:
    if ctx.studio_id is None:
        raise ApiError(409, "no_studio", "create or join a studio first")
    return ctx


def _staff(ctx: Annotated[Ctx, Depends(_member)]) -> Ctx:
    if not ctx.is_staff:
        raise forbidden()
    return ctx


def _owner(ctx: Annotated[Ctx, Depends(_member)]) -> Ctx:
    if ctx.role != "owner":
        raise forbidden("studio owner only")
    return ctx


AnonCtx = Annotated[Ctx, Depends(_anon, scope="function")]
UserCtx = Annotated[Ctx, Depends(_user, scope="function")]
MemberCtx = Annotated[Ctx, Depends(_member)]
StaffCtx = Annotated[Ctx, Depends(_staff)]
OwnerCtx = Annotated[Ctx, Depends(_owner)]


def get_project(ctx: Ctx, project_id: uuid.UUID) -> dict:
    """RLS returns no row for other tenants / ungranted clients -> uniform 404."""
    row = ctx.conn.execute("select * from projects where id = %s", (project_id,)).fetchone()
    if not row:
        raise not_found("project")
    return row
