import uuid

from app.config import settings
from app.security import create_token
from tests.conftest import ORIGIN, designer_with_studio, new_client, register, uniq


def test_register_login_me_logout():
    c = new_client()
    email = f"{uniq()}@example.com"
    body = register(c, email=email)
    assert body["user"]["email"] == email and body["studio"] is None
    cookie = c.cookies.get(settings.cookie_name)
    assert cookie
    assert c.get("/auth/me").json()["user"]["email"] == email
    assert c.post("/auth/logout").status_code == 200
    assert c.get("/auth/me").status_code == 401

    c2 = new_client()
    r = c2.post("/auth/login", json={"email": email.upper(), "password": "correct-horse-1"})
    assert r.status_code == 200
    assert c2.get("/auth/me").status_code == 200


def test_cookie_flags():
    c = new_client()
    r = c.post("/auth/register", json={"email": f"{uniq()}@example.com", "password": "correct-horse-1"})
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=lax" in sc and "max-age=3600" in sc


def test_duplicate_email_and_weak_password():
    c = new_client()
    email = f"{uniq()}@example.com"
    register(c, email=email)
    r = new_client().post("/auth/register", json={"email": email, "password": "correct-horse-1"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "email_taken"
    r = new_client().post("/auth/register", json={"email": f"{uniq()}@example.com", "password": "short"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_bad_password_and_unknown_email():
    c = new_client()
    email = f"{uniq()}@example.com"
    register(c, email=email)
    r = new_client().post("/auth/login", json={"email": email, "password": "wrong-password"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    r = new_client().post("/auth/login", json={"email": f"{uniq()}@example.com", "password": "wrong-password"})
    assert r.status_code == 401


def test_expired_and_tampered_jwt():
    c = new_client()
    uid = register(c)["user"]["id"]
    c.cookies.set(settings.cookie_name, create_token(uuid.UUID(uid), ttl=-10))
    assert c.get("/auth/me").status_code == 401
    good = create_token(uuid.UUID(uid))
    c.cookies.set(settings.cookie_name, good[:-3] + ("AAA" if not good.endswith("AAA") else "BBB"))
    assert c.get("/auth/me").status_code == 401
    c.cookies.set(settings.cookie_name, good)
    assert c.get("/auth/me").status_code == 200


def test_csrf_origin_rejection():
    c, _ = designer_with_studio()
    for headers in ({"Origin": "https://evil.example"}, {"Origin": ""}):
        r = c.post("/projects", json={"name": "x"}, headers=headers)
        assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_origin_rejected"
    # no Origin and no Referer
    from fastapi.testclient import TestClient
    from app.main import app

    bare = TestClient(app)
    bare.cookies = c.cookies
    assert bare.post("/projects", json={"name": "x"}).status_code == 403
    assert bare.post("/projects", json={"name": "x"}, headers={"Referer": f"{ORIGIN}/app"}).status_code == 201
    # second configured origin is allowed; GET never needs Origin
    assert c.post("/projects", json={"name": "y"}, headers={"Origin": "http://other.allowed"}).status_code == 201
    assert bare.get("/projects").status_code == 200


def test_cors_only_for_frontend_origin():
    c = new_client()
    r = c.options("/auth/login", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") == ORIGIN
    assert r.headers.get("access-control-allow-credentials") == "true"
    r = c.options("/auth/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers


def test_login_rate_limit():
    c = new_client()
    email = f"{uniq()}@example.com"
    codes = [c.post("/auth/login", json={"email": email, "password": "wrong-password"}).status_code for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429


def test_studio_slug_validation_and_uniqueness():
    c, s = designer_with_studio()
    assert c.post("/studios", json={"name": "Again", "slug": uniq("x-")}).status_code == 409  # one studio per account
    c2 = new_client()
    register(c2)
    for bad in ("AB", "has space", "x" * 41, "Upper"):
        assert c2.post("/studios", json={"name": "S", "slug": bad}).status_code == 422
    r = c2.post("/studios", json={"name": "S", "slug": s["slug"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "slug_taken"


def test_studio_trial_and_credits():
    c, _ = designer_with_studio()
    st = c.get("/studio").json()
    assert st["subscription"]["status"] == "trial" and st["credits"] == 50
    assert c.get("/studio/credits").json()["balance"] == 50
    assert c.get("/studio/audit").status_code == 200
