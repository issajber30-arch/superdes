"""Tenant isolation through the API and directly at the database (RLS as app_user)."""
import io

import psycopg
import pytest
from PIL import Image

from app.services.render import worker
from tests.conftest import ADMIN_URL, APP_URL, create_project, designer_with_studio, geometry, invite_client, new_client

TENANT_TABLES = [
    "users", "studios", "studio_members", "studio_branding", "subscriptions", "credit_ledger", "audit_events", "projects",
    "project_permissions", "invitations", "floor_plans", "plan_versions", "briefs", "finish_selections", "uploads",
    "moodboards", "moodboard_items", "design_alternatives", "estimate_items", "ai_conversations", "ai_messages",
    "ai_preferences", "render_jobs", "review_comments", "review_decisions", "project_tasks", "project_messages",
    "design_dossiers"]


def _png():
    b = io.BytesIO()
    Image.new("RGB", (8, 8)).save(b, "PNG")
    return b.getvalue()


@pytest.fixture(scope="module")
def world():
    """Studio A with a fully populated project; studio B with its own."""
    a, sa = designer_with_studio()
    pid = create_project(a)["id"]
    a.put(f"/projects/{pid}/brief", json={"styles": ["modern"]})
    a.put(f"/projects/{pid}/finishes", json={"room_id": "r1", "surface": "floor", "finish_key": "oak-parquet"})
    a.put(f"/projects/{pid}/estimates/overrides/furn:sofa-3", json={"unit_low": 1})
    up = a.post(f"/projects/{pid}/uploads", files={"file": ("a.png", _png(), "image/png")}).json()
    mb = a.post(f"/projects/{pid}/moodboards", json={"name": "A board"}).json()
    a.post(f"/projects/{pid}/moodboards/{mb['id']}/items", json={"kind": "note", "note": "secret"})
    a.post(f"/projects/{pid}/alternatives", json={"name": "Alt"})
    ai = a.post(f"/projects/{pid}/ai/messages", json={"message": "ideas"}).json()
    a.post(f"/projects/{pid}/ai/suggestions/{ai['message']['suggestions'][0]['id']}/feedback", json={"decision": "accept"})
    rj = a.post(f"/projects/{pid}/renders", json={}).json()
    while worker.run_once():
        pass
    a.post(f"/projects/{pid}/comments", json={"body": "A comment"})
    a.post(f"/projects/{pid}/decisions", json={"plan_version_no": 1, "decision": "concept_approved"})
    task = a.post(f"/projects/{pid}/tasks", json={"title": "A task"}).json()
    a.post(f"/projects/{pid}/messages", json={"body": "A message"})
    dos = a.post(f"/projects/{pid}/dossiers", json={}).json()
    a.post("/invitations", json={"role": "client", "project_id": pid})
    a.put("/studio/branding", json={"display_name": "Studio A Brand"})
    b, sb = designer_with_studio()
    pid_b = create_project(b)["id"]
    sid_a = a.get("/studio").json()["studio"]["id"]
    sid_b = b.get("/studio").json()["studio"]["id"]
    uid_b = b.get("/auth/me").json()["user"]["id"]
    return dict(a=a, b=b, pid=pid, pid_b=pid_b, sa=sa, sb=sb, up=up, mb=mb, rj=rj, task=task, dos=dos, ai=ai,
                sid_a=sid_a, sid_b=sid_b, uid_b=uid_b)


def test_cross_tenant_api_is_404(world):
    b, pid = world["b"], world["pid"]
    gets = ["", "/plan", "/plan/versions", "/plan/versions/1", "/plan/compare?from=1&to=1", "/brief", "/finishes",
            "/estimates", "/shopping-list", "/uploads", f"/uploads/{world['up']['id']}/content", "/moodboards",
            f"/moodboards/{world['mb']['id']}", "/alternatives", "/ai/conversations",
            f"/ai/conversations/{world['ai']['conversation_id']}/messages", "/ai/preferences", "/renders",
            f"/renders/{world['rj']['id']}", f"/renders/{world['rj']['id']}/image", "/comments", "/decisions", "/tasks",
            "/messages", "/dossiers", f"/dossiers/{world['dos']['id']}"]
    for path in gets:
        r = b.get(f"/projects/{pid}{path}")
        assert r.status_code == 404, (path, r.status_code)
    writes = [("post", "/plan/versions", {"geometry": geometry()}), ("post", "/renders", {}), ("post", "/messages", {"body": "x"}),
              ("post", "/tasks", {"title": "x"}), ("patch", f"/tasks/{world['task']['id']}", {"status": "done"}),
              ("post", "/comments", {"body": "x"}), ("post", "/dossiers", {}), ("put", "/brief", {}),
              ("post", "/ai/messages", {"message": "x"}), ("post", "/estimates/items", {"label": "x"}),
              ("post", "/plan/versions/1/review", {})]
    for method, path, body in writes:
        r = getattr(b, method)(f"/projects/{pid}{path}", json=body)
        assert r.status_code == 404, (method, path, r.status_code)
    assert b.post(f"/projects/{pid}/uploads", files={"file": ("a.png", _png(), "image/png")}).status_code == 404
    assert pid not in {p["id"] for p in b.get("/projects").json()["projects"]}
    assert b.post("/invitations", json={"role": "client", "project_id": pid}).status_code == 404
    # A's credits untouched by B's attempts
    assert world["a"].get("/studio/credits").json()["balance"] == 49


def test_client_sees_only_granted_project(world):
    a, pid = world["a"], world["pid"]
    pid2 = create_project(a, name="Other client")["id"]
    client, _ = invite_client(a, pid)
    assert client.get(f"/projects/{pid}").status_code == 200
    assert [p["id"] for p in client.get("/projects").json()["projects"]] == [pid]
    for path in ("", "/plan", "/renders", "/messages", "/estimates", "/dossiers"):
        assert client.get(f"/projects/{pid2}{path}").status_code == 404
    assert client.post(f"/projects/{pid2}/messages", json={"body": "x"}).status_code == 404
    assert client.get("/studio/members").status_code == 403
    assert client.get("/studio/credits").status_code == 403
    assert client.get("/invitations").status_code == 403
    people = client.get(f"/projects/{pid}").json()["people"]
    assert all(p["role"] in ("owner", "designer", "client") for p in people)


def test_branding_slug_isolation(world):
    pub_b = new_client().get(f"/public/studios/{world['sb']['slug']}").json()
    assert pub_b["display_name"] != "Studio A Brand"
    assert new_client().get(f"/public/studios/{world['sa']['slug']}").json()["display_name"] == "Studio A Brand"
    assert world["b"].get("/studio/branding").json()["display_name"] != "Studio A Brand"
    assert new_client().get("/public/studios/zz-none").status_code == 404


def _count_a_rows(conn, table, sid_a):
    col = {"users": None, "studios": "id"}.get(table, "studio_id")
    if col is None:
        return conn.execute("select count(*) from users u join studio_members m on m.user_id = u.id "
                            "where m.studio_id = %s", (sid_a,)).fetchone()[0]
    return conn.execute(f"select count(*) from {table} where {col} = %s", (sid_a,)).fetchone()[0]


def test_direct_sql_rls_as_app_user(world):
    sid_a, sid_b, uid_b = world["sid_a"], world["sid_b"], world["uid_b"]
    with psycopg.connect(ADMIN_URL) as admin:  # the test is not vacuous: A has rows in every tenant table
        for t in TENANT_TABLES:
            assert _count_a_rows(admin, t, sid_a) > 0, t
    with psycopg.connect(APP_URL) as conn:
        assert conn.execute("select rolsuper, rolbypassrls from pg_roles where rolname = current_user").fetchone() == (False, False)
        # studio B context: zero rows of studio A anywhere
        conn.execute("select set_config('app.user_id', %s, true), set_config('app.studio_id', %s, true)", (uid_b, sid_b))
        for t in TENANT_TABLES:
            assert conn.execute(f"select count(*) from {t}").fetchone()[0] >= 0
            # studio_members/users joins are themselves RLS-filtered, so a direct where-clause count suffices
            assert _count_a_rows(conn, t, sid_a) == 0, t
        assert conn.execute("select count(*) from projects").fetchone()[0] >= 1  # sees B's own data
        # forging studio A while being user B: B is not a member of A -> project data still hidden
        conn.execute("select set_config('app.studio_id', %s, true)", (sid_a,))
        for t in ("projects", "plan_versions", "render_jobs", "project_messages", "design_dossiers", "estimate_items", "uploads"):
            assert conn.execute(f"select count(*) from {t}").fetchone()[0] == 0, t
        conn.rollback()
        # no settings at all: zero rows in every tenant table
        for t in TENANT_TABLES:
            assert conn.execute(f"select count(*) from {t}").fetchone()[0] == 0, t
        conn.rollback()
        # cannot write into A's tenant data from B's context
        conn.execute("select set_config('app.user_id', %s, true), set_config('app.studio_id', %s, true)", (uid_b, sid_b))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("insert into project_messages (studio_id, project_id, author_id, body) values (%s,%s,%s,'x')",
                         (sid_a, world["pid"], uid_b))
        conn.rollback()
        conn.execute("select set_config('app.user_id', %s, true), set_config('app.studio_id', %s, true)", (uid_b, sid_b))
        assert conn.execute("update plan_versions set review_status = 'conceptual' where project_id = %s", (world["pid"],)).rowcount == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update plan_versions set geometry = '{}'")  # geometry is immutable (no column grant)
        conn.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("drop table users")  # app_user owns nothing
        conn.rollback()


def test_definer_functions_not_exposed_to_public():
    with psycopg.connect(APP_URL) as conn:
        rows = conn.execute("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                            "where n.nspname = 'public' and p.prosecdef and has_function_privilege('public', p.oid, 'execute')").fetchall()
        assert rows == []
