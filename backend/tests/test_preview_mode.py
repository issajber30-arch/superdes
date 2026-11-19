import pytest

from app.config import settings
from scripts.migrate import migrate
from tests.conftest import ADMIN_URL, APP_PW, create_project, new_client, uniq


@pytest.fixture
def preview(monkeypatch):
    # preview mode needs an empty users table; later test modules create their own data
    migrate(ADMIN_URL, reset=True, app_password=APP_PW)
    monkeypatch.setattr(settings, "preview_mode", True)


def _reg(c):
    return c.post("/auth/register", json={"email": f"{uniq()}@example.com", "password": "correct-horse-1"})


def _is_preview_403(r):
    return r.status_code == 403 and r.json()["error"]["code"] == "preview_mode"


def test_preview_mode_single_owner(preview):
    assert new_client().get("/health").json() == {"status": "ok", "db": "ok", "preview_mode": True, "setup_open": True}
    owner = new_client()
    assert _reg(owner).status_code == 201
    assert new_client().get("/health").json()["setup_open"] is False
    assert _is_preview_403(_reg(new_client()))

    slug = uniq("st-")
    assert owner.post("/studios", json={"name": "Mine", "slug": slug}).status_code == 201
    p = create_project(owner)
    assert owner.get(f"/projects/{p['id']}").status_code == 200
    assert owner.put("/studio/branding", json={"display_name": "Mine"}).status_code == 200
    assert owner.get("/studio/members").json()["members"][0]["role"] == "owner"

    anon = new_client()
    assert _is_preview_403(anon.get(f"/public/studios/{slug}"))
    assert _is_preview_403(anon.post(f"/public/studios/{slug}/join",
                                     json={"email": f"{uniq()}@example.com", "password": "correct-horse-1"}))
    assert _is_preview_403(owner.post("/invitations", json={"role": "client", "project_id": p["id"]}))
    tok = "x" * 30
    assert _is_preview_403(anon.get(f"/public/invitations/{tok}"))
    assert _is_preview_403(anon.post(f"/public/invitations/{tok}/accept", json={}))


def test_flag_off_by_default():
    assert settings.preview_mode is False
    assert set(new_client().get("/health").json()) == {"status", "db"}
