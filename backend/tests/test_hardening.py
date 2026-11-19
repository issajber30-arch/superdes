import io
import time

import psycopg
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.db import tenant_tx
from app.errors import ApiError
from app.main import MAX_BODY
from app.security import RateLimiter
from app.services.render import worker
from tests.conftest import (ORIGIN, admin_sql, create_project, designer_with_studio, invite_client, new_client, register,
                            uniq)


def test_chunked_body_over_limit_is_413():
    c = new_client()
    chunk = b"x" * (1024 * 1024)
    n = MAX_BODY // len(chunk) + 2
    r = c.post("/auth/login", content=(chunk for _ in range(n)), headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    # small chunked bodies still work
    r = c.post("/auth/login", content=iter([b'{"email":"a@example.com",', b'"password":"wrong-password"}']),
               headers={"Content-Type": "application/json"})
    assert r.status_code == 401


def test_login_ip_bucket_and_limiter_prunes_idle_keys():
    c = new_client()
    codes = [c.post("/auth/login", json={"email": f"{uniq()}@example.com", "password": "wrong-password"}).status_code
             for _ in range(51)]
    assert codes[:50] == [401] * 50 and codes[50] == 429  # per-IP bucket, different emails
    lim = RateLimiter(limit=1, window_s=0.05)
    for i in range(100):
        lim.hit(f"k{i}")
    assert not lim.hit("k0")
    time.sleep(0.1)
    assert lim.hit("fresh") and set(lim.hits) == {"fresh"}


def test_signup_and_join_rate_limited_per_ip():
    _, s = designer_with_studio()  # 1 sign-up
    c = new_client()
    for _ in range(18):
        register(c)
    ok = c.post(f"/public/studios/{s['slug']}/join", json={"email": f"{uniq()}@example.com", "password": "guest-pass-1"})
    assert ok.status_code == 201
    r = new_client().post(f"/public/studios/{s['slug']}/join", json={"email": f"{uniq()}@example.com", "password": "guest-pass-1"})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert new_client().post("/auth/register", json={"email": f"{uniq()}@example.com", "password": "correct-horse-1",
                                                     "display_name": "x"}).status_code == 429


def test_client_render_quota_staff_unlimited():
    d, _ = designer_with_studio()
    pid = create_project(d)["id"]
    client, _ = invite_client(d, pid)
    codes = [client.post(f"/projects/{pid}/renders", json={}).status_code for _ in range(6)]
    assert codes == [202] * 5 + [429]
    assert client.post(f"/projects/{pid}/renders", json={}).json()["error"]["code"] == "render_quota_exceeded"
    assert all(d.post(f"/projects/{pid}/renders", json={}).status_code == 202 for _ in range(7))


def test_ai_chat_releases_db_connection_and_is_rate_limited(monkeypatch):
    from app import db
    from app.routers import ai

    seen = []

    class Fake:
        name = "fake"

        def advise(self, ctx, msg):
            stats = db.pool.get_stats()
            seen.append(stats["pool_size"] - stats["pool_available"])  # connections checked out right now
            return {"message": "ok", "suggestions": []}

    monkeypatch.setattr(ai, "get_consultant", lambda: Fake())
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    codes = [c.post(f"/projects/{pid}/ai/messages", json={"message": "hi"}).status_code for _ in range(21)]
    assert codes == [201] * 20 + [429]
    assert seen and all(n == 0 for n in seen)


def test_rls_clients_cannot_edit_others_rows_and_refund_needs_failed_job():
    d, s = designer_with_studio()
    pid = create_project(d)["id"]
    client, _ = invite_client(d, pid)
    assert d.post(f"/projects/{pid}/comments", json={"body": "designer note"}).status_code == 201
    assert client.post(f"/projects/{pid}/comments", json={"body": "client note"}).status_code == 201
    jid = d.post(f"/projects/{pid}/renders", json={}).json()["id"]
    sid = s["studio"]["id"]
    cuid = client.get("/auth/me").json()["user"]["id"]
    duid = d.get("/auth/me").json()["user"]["id"]
    with tenant_tx(cuid, sid) as conn:
        assert conn.execute("update review_comments set body = 'x' where project_id = %s and author_id <> %s",
                            (pid, cuid)).rowcount == 0
        assert conn.execute("delete from render_jobs where id = %s", (jid,)).rowcount == 0
        assert conn.execute("update review_comments set body = 'edited' where author_id = %s", (cuid,)).rowcount == 1
        assert len(conn.execute("select 1 from review_comments where project_id = %s", (pid,)).fetchall()) == 2
    with pytest.raises(psycopg.errors.InsufficientPrivilege):  # job is queued, not failed
        with tenant_tx(duid, sid) as conn:
            conn.execute("insert into credit_ledger (studio_id, delta, reason, render_job_id, created_by) "
                         "values (%s, 1, 'render_refund', %s, %s)", (sid, jid, duid))

    class Boom:
        def render(self, scene):
            raise RuntimeError("boom")

    while worker.run_once(Boom()):
        pass
    assert admin_sql("select count(*) from credit_ledger where render_job_id = %s and reason = 'render_refund'", (jid,))[0][0] == 1


def test_invitation_email_must_match():
    d, _ = designer_with_studio()
    pid = create_project(d)["id"]
    email = f"{uniq('inv')}@example.com"
    tok = d.post("/invitations", json={"role": "client", "project_id": pid, "email": email}).json()["token"]
    r = new_client().post(f"/public/invitations/{tok}/accept", json={"email": f"{uniq()}@example.com", "password": "client-pass-1"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "invitation_email_mismatch"
    assert new_client().get(f"/public/invitations/{tok}").json()["valid"] is True  # not consumed
    ok = new_client().post(f"/public/invitations/{tok}/accept", json={"email": email.upper(), "password": "client-pass-1"})
    assert ok.status_code == 200 and ok.json()["role"] == "client"


def test_decompression_bomb_warning_range_is_rejected():
    from app.services.storage import inspect_image

    side = int((Image.MAX_IMAGE_PIXELS * 1.2) ** 0.5)  # between 1x and 2x: Pillow only warns here
    buf = io.BytesIO()
    Image.new("1", (side, side)).save(buf, "PNG")
    with pytest.raises(ApiError) as e:
        inspect_image(buf.getvalue())
    assert e.value.status_code == 400


def test_prod_requires_explicit_settings_and_hsts(monkeypatch):
    from app.config import Settings
    from app.main import app

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "y" * 40)
    monkeypatch.setenv("COOKIE_SECURE", "1")
    monkeypatch.delenv("DATABASE_URL")
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        Settings()
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/y")
    monkeypatch.delenv("FRONTEND_ORIGIN")
    with pytest.raises(RuntimeError, match="FRONTEND_ORIGIN"):
        Settings()
    monkeypatch.setenv("FRONTEND_ORIGIN", "https://app.example")
    assert Settings().is_prod

    assert "strict-transport-security" not in new_client().get("/health").headers
    https = TestClient(app, base_url="https://testserver", headers={"Origin": ORIGIN})
    assert https.get("/health").headers["strict-transport-security"] == "max-age=31536000"
