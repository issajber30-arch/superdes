import uuid

import psycopg
from fastapi import APIRouter, Request, Response

from ..config import settings
from ..db import set_context
from ..deps import AnonCtx, Ctx, UserCtx, load_membership, session_user_id
from ..errors import ApiError, error_json, preview_closed
from ..schemas import Credentials, Register
from ..security import (client_ip, create_token, hash_password, limit, login_ip_limiter, login_limiter, signup_limiter,
                        verify_password)
from ..services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


def set_session_cookie(response: Response, user_id):
    response.set_cookie(settings.cookie_name, create_token(user_id), max_age=settings.jwt_ttl_seconds, httponly=True,
                        secure=settings.cookie_secure, samesite=settings.cookie_samesite, path="/")


def clear_session_cookie(response: Response):
    response.delete_cookie(settings.cookie_name, path="/", httponly=True, secure=settings.cookie_secure,
                           samesite=settings.cookie_samesite)


def create_user(ctx: Ctx, body: Register) -> uuid.UUID:
    uid = uuid.uuid4()
    set_context(ctx.conn, uid, None)
    try:
        with ctx.conn.transaction():  # savepoint so the 409 is clean
            ctx.conn.execute("insert into users (id, email, password_hash, display_name) values (%s,%s,%s,%s)",
                             (uid, body.email.strip().lower(), hash_password(body.password), body.display_name.strip()))
    except psycopg.errors.UniqueViolation:
        raise ApiError(409, "email_taken", "an account with this email already exists")
    ctx.user_id = uid
    return uid


def me_payload(ctx: Ctx) -> dict:
    user = ctx.conn.execute("select id, email, display_name, created_at from users where id = %s", (ctx.user_id,)).fetchone()
    studio = None
    if ctx.studio_id:
        studio = ctx.conn.execute("select id, slug, name from studios where id = %s", (ctx.studio_id,)).fetchone()
    return {"user": user, "studio": studio, "role": ctx.role}


@router.post("/register", status_code=201)
def register(body: Register, ctx: AnonCtx, request: Request, response: Response):
    limit(signup_limiter, client_ip(request), "sign-ups")
    if settings.preview_mode and ctx.conn.execute("select app_has_users() as v").fetchone()["v"]:
        raise preview_closed()
    uid = create_user(ctx, body)
    audit.log(ctx.conn, "auth.register", None, uid, "user", uid)
    set_session_cookie(response, uid)
    return me_payload(ctx)


@router.post("/login")
def login(body: Credentials, ctx: AnonCtx, request: Request, response: Response):
    limit(login_ip_limiter, client_ip(request), "login attempts")
    limit(login_limiter, body.email.strip().lower(), "login attempts")
    row = ctx.conn.execute("select * from auth_login_lookup(%s)", (body.email.strip(),)).fetchone()
    if not verify_password(body.password, row["password_hash"] if row else None):
        audit.log(ctx.conn, "auth.login_failed", None, row["id"] if row else None, "user", row["id"] if row else None)
        return error_json(401, "invalid_credentials", "email or password is incorrect")
    ctx.user_id = row["id"]
    set_context(ctx.conn, ctx.user_id)
    load_membership(ctx)
    audit.log(ctx.conn, "auth.login", ctx.studio_id, ctx.user_id, "user", ctx.user_id)
    set_session_cookie(response, ctx.user_id)
    return me_payload(ctx)


@router.post("/logout")
def logout(ctx: AnonCtx, request: Request, response: Response):
    uid = session_user_id(request)
    if uid:
        set_context(ctx.conn, uid)
        if ctx.conn.execute("select 1 from users where id = %s", (uid,)).fetchone():
            audit.log(ctx.conn, "auth.logout", None, uid, "user", uid)
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(ctx: UserCtx):
    return me_payload(ctx)
