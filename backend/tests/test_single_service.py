"""SERVE_FRONTEND: the SPA is served from the API's own origin, and API routes still win over the static mount."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import mount_frontend


def test_spa_and_api_share_one_origin(monkeypatch):
    monkeypatch.setenv("API_URL", "https://superdes.example.com")
    target = FastAPI()
    target.get("/health")(lambda: {"status": "ok"})
    mount_frontend(target)
    c = TestClient(target)

    page = c.get("/")
    assert page.status_code == 200 and "<html" in page.text.lower()
    csp = page.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp and "connect-src 'self' https://superdes.example.com" in csp

    cfg = c.get("/config.js")
    assert '"apiUrl": "https://superdes.example.com"' in cfg.text

    assert c.get("/health").json() == {"status": "ok"}  # API route registered before the mount is not shadowed
    assert c.get("/js/api.js").status_code == 200
    assert c.get("/nope.txt").status_code == 404


def test_bad_api_url_refuses_to_start(monkeypatch):
    monkeypatch.setenv("API_URL", "javascript:alert(1)")
    try:
        mount_frontend(FastAPI())
    except SystemExit:
        return
    raise AssertionError("an invalid API_URL must stop startup")
