"""Static frontend server: serves the SPA, /config.js (from API_URL) and /healthz with security headers."""
import json
import os
import re
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
PREVIEW_MODE = os.environ.get("PREVIEW_MODE", "").strip().lower() in ("1", "true", "yes", "on")
API_URL = os.environ.get("API_URL", "http://localhost:8010").strip().rstrip("/")
# API_URL goes into a header (CSP) and a script: accept only a bare http(s) origin
if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?", API_URL):
    raise SystemExit(f"API_URL must be an http(s) origin like https://api.example.com, got {API_URL!r}")

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    f"connect-src 'self' {API_URL}",
    f"img-src 'self' data: blob: {API_URL}",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])
HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}
PROD = os.environ.get("ENV", "").lower() in ("prod", "production")
HSTS = (b"strict-transport-security", b"max-age=31536000")


def config_js(_request):
    body = "window.APP_CONFIG = " + json.dumps({"apiUrl": API_URL, "previewMode": PREVIEW_MODE}) + ";\n"
    return Response(body, media_type="application/javascript", headers={"Cache-Control": "no-store"})


def healthz(_request):
    return JSONResponse({"status": "ok"})


app = Starlette(routes=[
    Route("/config.js", config_js),
    Route("/healthz", healthz),
    Mount("/", StaticFiles(directory=ROOT / "static", html=True)),
])


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", [])
                           if k.decode().lower() not in {h.lower() for h in HEADERS}]
                headers += [(k.lower().encode(), v.encode()) for k, v in HEADERS.items()]
                if PROD or scope.get("scheme") == "https":
                    headers.append(HSTS)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


asgi = SecurityHeaders(app)

if __name__ == "__main__":
    uvicorn.run(asgi, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "5173")), proxy_headers=True,
                # trust X-Forwarded-Proto/For: Railway's edge proxy is the only ingress
                forwarded_allow_ips="*")
