import os
import pathlib
import sys
import tempfile
import uuid

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
APP_PW = "app_user_test_pw"
ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL", "postgresql:///superdes_test")
APP_URL = os.environ.get("TEST_DATABASE_URL", f"postgresql://app_user:{APP_PW}@localhost:5432/superdes_test")
ORIGIN = "http://testfront.local"
os.environ.update(ENV="test", DATABASE_URL=APP_URL, FRONTEND_ORIGIN=f"{ORIGIN},http://other.allowed", COOKIE_SECURE="0",
                  RENDER_WORKER="0", UPLOAD_DIR=tempfile.mkdtemp(prefix="superdes-test-"), JWT_SECRET="test-secret-" + "x" * 32)
for k in ("OLLAMA_URL", "COMFYUI_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
    os.environ.pop(k, None)

import psycopg  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from scripts.migrate import migrate  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def fresh_db():
    migrate(ADMIN_URL, reset=True, app_password=APP_PW)
    yield
    from app.db import close_pool

    close_pool()


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from app.security import LIMITERS

    for lim in LIMITERS:
        lim.reset()


def admin_sql(query, params=None):
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        cur = c.execute(query, params)
        return cur.fetchall() if cur.description else None


def new_client() -> TestClient:
    from app.main import app

    return TestClient(app, headers={"Origin": ORIGIN})


def uniq(prefix="u") -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}"


def register(c, email=None, password="correct-horse-1", name="Test User"):
    r = c.post("/auth/register", json={"email": email or f"{uniq()}@example.com", "password": password, "display_name": name})
    assert r.status_code == 201, r.text
    return r.json()


def designer_with_studio(slug=None):
    c = new_client()
    register(c, name="Designer")
    slug = slug or uniq("st-")
    r = c.post("/studios", json={"name": f"Studio {slug}", "slug": slug})
    assert r.status_code == 201, r.text
    return c, r.json() | {"slug": slug}


def geometry(sofa_x=1000, wall_x=5000, door_offset=500, room_name="Living"):
    return {
        "walls": [
            {"id": "w1", "a": [0, 0], "b": [wall_x, 0], "thickness": 200, "structural": True},
            {"id": "w2", "a": [wall_x, 0], "b": [wall_x, 4000], "thickness": 100, "structural": False},
            {"id": "w3", "a": [wall_x, 4000], "b": [0, 4000], "thickness": 200, "structural": True},
            {"id": "w4", "a": [0, 4000], "b": [0, 0], "thickness": 100, "structural": False},
        ],
        "openings": [{"id": "o1", "wall_id": "w4", "offset": door_offset, "width": 900, "kind": "door"},
                     {"id": "o2", "wall_id": "w1", "offset": 1500, "width": 1200, "kind": "window"}],
        "rooms": [{"id": "r1", "name": room_name, "kind": "living", "polygon": [[0, 0], [wall_x, 0], [wall_x, 4000], [0, 4000]]}],
        "fixtures": [],
        "furniture": [{"id": "f1", "catalog_key": "sofa-3", "x": sofa_x, "y": 2800, "w": 2100, "d": 900, "rot": 0},
                      {"id": "f2", "catalog_key": "coffee-table", "x": 1500, "y": 1800, "w": 1100, "d": 600, "rot": 0}],
    }


def create_project(c, geom=None, name="Flat"):
    r = c.post("/projects", json={"name": name, "geometry": geom if geom is not None else geometry()})
    assert r.status_code == 201, r.text
    return r.json()


def invite_client(designer, project_id):
    r = designer.post("/invitations", json={"role": "client", "project_id": project_id})
    assert r.status_code == 201, r.text
    client = new_client()
    r2 = client.post(f"/public/invitations/{r.json()['token']}/accept",
                     json={"email": f"{uniq('cl')}@example.com", "password": "client-pass-1", "display_name": "Client"})
    assert r2.status_code == 200, r2.text
    return client, r.json()["token"]
