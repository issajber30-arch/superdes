from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..config import settings
from ..db import tenant_tx

router = APIRouter(tags=["health"])


# HEAD too: uptime monitors send HEAD, which would otherwise fall through to the mounted SPA and 404
@router.api_route("/health", methods=["GET", "HEAD"])
def health():
    try:
        with tenant_tx() as conn:
            conn.execute("select 1")
            if settings.preview_mode:
                return {"status": "ok", "db": "ok", "preview_mode": True,
                        "setup_open": not conn.execute("select app_has_users() as v").fetchone()["v"]}
        return {"status": "ok", "db": "ok"}
    except Exception:
        return JSONResponse(status_code=503, content={"status": "degraded", "db": "unreachable"})
