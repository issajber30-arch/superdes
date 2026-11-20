import asyncio
import importlib.util
import logging
import os
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import BACKEND_DIR, settings
from .db import close_pool, open_pool
from .errors import ApiError, error_json
from .routers import (ai, audit, auth, branding, briefs, catalog, collab, credits, dossiers, estimates, health, invites,
                      moodboards, plans, projects, renders, studios)
from .services.render.worker import worker_loop

log = logging.getLogger("superdes")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
MAX_BODY = 12 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_pool()
    stop, task = asyncio.Event(), None
    if settings.render_worker:
        task = asyncio.create_task(worker_loop(stop))
    yield
    stop.set()
    if task:
        await task
    close_pool()


# max_body_size: Starlette counts received bytes, so chunked bodies without content-length are capped too (-> 413)
app = FastAPI(title="SuperDes API", version="0.1.0", lifespan=lifespan, max_body_size=MAX_BODY)


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.method in UNSAFE:
        # CSRF: state-changing requests must come from an allowed frontend origin
        origin = request.headers.get("origin")
        if not origin and (ref := request.headers.get("referer")):
            parts = urlsplit(ref)
            origin = f"{parts.scheme}://{parts.netloc}"
        if (origin or "").rstrip("/") not in settings.frontend_origins:
            return error_json(403, "csrf_origin_rejected", "request origin is not allowed")
        cl = request.headers.get("content-length", "0")  # fast path; max_body_size also counts chunked bodies
        if not cl.isdigit() or int(cl) > MAX_BODY:
            return error_json(413, "too_large", "request body too large")
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if request.url.scheme == "https" or settings.is_prod:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    return response


# added after guard so CORS wraps it (preflights answered, error responses still get CORS headers)
app.add_middleware(CORSMiddleware, allow_origins=settings.frontend_origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type"], max_age=600)


@app.exception_handler(ApiError)
async def api_error(_, exc: ApiError):
    return error_json(exc.status_code, exc.code, exc.detail, jsonable_encoder(exc.details))


@app.exception_handler(StarletteHTTPException)
async def http_error(_, exc: StarletteHTTPException):
    codes = {401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 413: "too_large"}
    return error_json(exc.status_code, codes.get(exc.status_code, "http_error"), str(exc.detail))


def _clean_errors(errors) -> list[dict]:
    return [{"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in errors]


@app.exception_handler(RequestValidationError)
async def validation_error(_, exc: RequestValidationError):
    return error_json(422, "validation_error", "request validation failed", _clean_errors(exc.errors()))


@app.exception_handler(ValidationError)
async def model_validation_error(_, exc: ValidationError):
    return error_json(422, "validation_error", "request validation failed", _clean_errors(exc.errors()))


@app.exception_handler(Exception)
async def unhandled(_, exc: Exception):
    log.exception("unhandled error", exc_info=exc)
    return error_json(500, "internal_error", "internal server error")


for r in (health, auth, studios, branding, credits, audit, invites, projects, plans, briefs, catalog, moodboards,
          estimates, ai, renders, collab, dossiers):
    app.include_router(r.router)


def mount_frontend(target: FastAPI):
    """Serve the SPA (frontend/server.py, with its CSP and /config.js) from this app, after the API routes.
    One origin for page and API keeps the session cookie first-party: Safari blocks it across *.onrender.com hosts."""
    spec = importlib.util.spec_from_file_location("frontend_server", BACKEND_DIR.parent / "frontend" / "server.py")
    frontend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(frontend)  # reads API_URL; set it (and FRONTEND_ORIGIN) to this service's public URL
    target.mount("/", frontend.asgi)


if os.environ.get("SERVE_FRONTEND", "").strip().lower() in ("1", "true", "yes", "on"):
    mount_frontend(app)
