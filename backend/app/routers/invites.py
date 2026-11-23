import uuid
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Path, Request, Response
from pydantic import Field

from ..config import settings
from ..db import set_context
from ..deps import AnonCtx, StaffCtx, get_project, load_membership, session_user_id
from ..errors import ApiError, forbidden, not_found, preview_closed
from ..schemas import Email, Register, Strict
from ..security import client_ip, hash_token, limit, new_invite_token, signup_limiter
from ..services import audit
from .auth import create_user, me_payload, set_session_cookie

router = APIRouter(tags=["invitations"])
Token = Annotated[str, Path(min_length=20, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]


class InviteCreate(Strict):
    role: Literal["client", "designer"] = "client"
    project_id: uuid.UUID | None = None
    email: Email | None = None
    ttl_hours: Annotated[int, Field(ge=1, le=720)] = 168


class InviteAccept(Strict):
    email: str | None = None
    password: str | None = None
    display_name: str = ""


@router.post("/invitations", status_code=201)
def create_invitation(body: InviteCreate, ctx: StaffCtx):
    if settings.preview_mode:
        raise preview_closed()
    if body.role == "designer" and ctx.role != "owner":
        raise forbidden("only the studio owner can invite designers")
    if body.role == "client":
        if not body.project_id:
            raise ApiError(422, "validation_error", "project_id is required for client invitations")
        get_project(ctx, body.project_id)
    token, token_hash = new_invite_token()
    row = ctx.conn.execute(
        "insert into invitations (studio_id, project_id, role, email, token_hash, expires_at, created_by) "
        "values (%s,%s,%s,%s,%s, now() + make_interval(hours => %s), %s) returning id, project_id, role, email, expires_at, created_at",
        (ctx.studio_id, body.project_id, body.role, body.email, token_hash, body.ttl_hours, ctx.user_id)).fetchone()
    audit.log(ctx.conn, "invitation.create", ctx.studio_id, ctx.user_id, "invitation", row["id"], {"role": body.role})
    # The raw token is only ever returned here; the DB stores its SHA-256.
    return {**row, "token": token, "accept_path": f"/invitations/{token}"}


@router.get("/invitations")
def list_invitations(ctx: StaffCtx):
    return {"invitations": ctx.conn.execute(
        "select id, project_id, role, email, expires_at, used_at, created_at from invitations where studio_id = %s "
        "order by created_at desc", (ctx.studio_id,)).fetchall()}


@router.delete("/invitations/{invitation_id}")
def revoke_invitation(invitation_id: uuid.UUID, ctx: StaffCtx):
    row = ctx.conn.execute("delete from invitations where id = %s and used_at is null returning id", (invitation_id,)).fetchone()
    if not row:
        raise not_found("invitation")
    audit.log(ctx.conn, "invitation.revoke", ctx.studio_id, ctx.user_id, "invitation", invitation_id)
    return {"ok": True}


@router.get("/public/invitations/{token}")
def preview_invitation(token: Token, ctx: AnonCtx):
    if settings.preview_mode:
        raise preview_closed()
    row = ctx.conn.execute("select * from invitation_preview(%s)", (hash_token(token),)).fetchone()
    if not row:
        raise not_found("invitation")
    return row


@router.post("/public/invitations/{token}/accept")
def accept_invitation(token: Token, body: InviteAccept, ctx: AnonCtx, request: Request, response: Response):
    """Logged-in user accepts with their account; otherwise email+password create a new account."""
    if settings.preview_mode:
        raise preview_closed()
    limit(signup_limiter, client_ip(request), "sign-ups")
    uid = session_user_id(request)
    if uid:
        set_context(ctx.conn, uid)
        if not ctx.conn.execute("select 1 from users where id = %s", (uid,)).fetchone():
            uid = None
    if uid:
        ctx.user_id = uid
    else:
        uid = create_user(ctx, Register(email=body.email or "", password=body.password or "",
                                        display_name=body.display_name or ""))
    try:
        with ctx.conn.transaction():
            inv = ctx.conn.execute("select * from invitation_accept(%s)", (hash_token(token),)).fetchone()
    except psycopg.errors.RaiseException as e:
        if "email_mismatch" in str(e):
            raise ApiError(403, "invitation_email_mismatch", "this invitation was sent to a different email address")
        if "other_studio" in str(e):
            raise ApiError(409, "already_in_studio", "this account belongs to another studio")
        raise ApiError(410, "invitation_invalid", "invitation is invalid, expired or already used")
    load_membership(ctx)
    audit.log(ctx.conn, "invitation.accept", ctx.studio_id, uid, "project", inv["project_id"], {"role": inv["role"]})
    set_session_cookie(response, uid)
    return {**me_payload(ctx), "project_id": inv["project_id"]}
