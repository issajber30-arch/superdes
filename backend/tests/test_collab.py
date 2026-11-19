import io

from PIL import Image

from app.services.render import worker
from tests.conftest import (admin_sql, create_project, designer_with_studio, geometry, invite_client, new_client,
                            register, uniq)


def png_bytes(color=(200, 10, 10)):
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), color).save(buf, "PNG")
    return buf.getvalue()


def test_invitation_single_use_and_expiry():
    d, _ = designer_with_studio()
    pid = create_project(d)["id"]
    client, token = invite_client(d, pid)
    assert client.get("/auth/me").json()["role"] == "client"
    assert client.get(f"/projects/{pid}").status_code == 200
    preview = new_client().get(f"/public/invitations/{token}").json()
    assert preview["valid"] is False
    again = new_client().post(f"/public/invitations/{token}/accept",
                              json={"email": f"{uniq()}@example.com", "password": "another-pass-1"})
    assert again.status_code == 410
    assert new_client().get("/public/invitations/" + "x" * 43).status_code == 404

    r = d.post("/invitations", json={"role": "client", "project_id": pid, "ttl_hours": 1}).json()
    admin_sql("update invitations set expires_at = now() - interval '1 minute' where id = %s", (r["id"],))
    assert new_client().post(f"/public/invitations/{r['token']}/accept",
                             json={"email": f"{uniq()}@example.com", "password": "another-pass-1"}).status_code == 410
    assert "token_hash" not in str(d.get("/invitations").json())
    assert d.post("/invitations", json={"role": "client"}).status_code == 422
    assert client.post("/invitations", json={"role": "client", "project_id": pid}).status_code == 403


def test_designer_invite_and_existing_user_accept():
    owner, _ = designer_with_studio()
    tok = owner.post("/invitations", json={"role": "designer"}).json()["token"]
    des = new_client()
    register(des)  # existing account with no studio accepts while logged in
    r = des.post(f"/public/invitations/{tok}/accept", json={})
    assert r.status_code == 200 and r.json()["role"] == "designer"
    assert des.post("/projects", json={"name": "by designer"}).status_code == 201
    assert des.get("/studio/audit").status_code == 403  # owner only
    # member of another studio cannot accept
    other, _ = designer_with_studio()
    tok2 = owner.post("/invitations", json={"role": "designer"}).json()["token"]
    assert other.post(f"/public/invitations/{tok2}/accept", json={}).status_code == 409


def test_public_studio_link_join_with_guest_plan():
    d, s = designer_with_studio()
    c = new_client()
    r = c.post(f"/public/studios/{s['slug']}/join", json={"email": f"{uniq()}@example.com", "password": "guest-pass-1",
                                                         "project_name": "Guest flat", "geometry": geometry()})
    assert r.status_code == 201, r.text
    pid = r.json()["project"]["id"]
    assert r.json()["role"] == "client"
    plan = c.get(f"/projects/{pid}/plan").json()
    assert plan["current_version"]["geometry"]["furniture"][0]["catalog_key"] == "sofa-3"
    assert pid in {p["id"] for p in d.get("/projects").json()["projects"]}
    assert new_client().post("/public/studios/no-such-studio/join",
                             json={"email": f"{uniq()}@example.com", "password": "guest-pass-1"}).status_code == 404


def test_comments_tasks_messages_and_decisions():
    d, _ = designer_with_studio()
    pid = create_project(d)["id"]
    client, _ = invite_client(d, pid)
    r = d.post(f"/projects/{pid}/comments", json={"body": "Move this sofa?", "element_id": "f1"})
    assert r.status_code == 201 and r.json()["plan_version_no"] == 1
    assert d.post(f"/projects/{pid}/comments", json={"body": "x", "element_id": "zzz"}).status_code == 422
    assert client.get(f"/projects/{pid}/comments").json()["comments"][0]["element_id"] == "f1"

    client_id = client.get("/auth/me").json()["user"]["id"]
    t = d.post(f"/projects/{pid}/tasks", json={"title": "Measure windows", "assignee_id": client_id}).json()
    assert t["status"] == "todo"
    t2 = client.patch(f"/projects/{pid}/tasks/{t['id']}", json={"status": "done"}).json()
    assert t2["status"] == "done" and t2["assignee_id"] == client_id
    assert client.delete(f"/projects/{pid}/tasks/{t['id']}").status_code == 403
    stranger, _ = designer_with_studio()
    stranger_id = stranger.get("/auth/me").json()["user"]["id"]
    assert d.post(f"/projects/{pid}/tasks", json={"title": "x", "assignee_id": stranger_id}).status_code == 422

    d.post(f"/projects/{pid}/messages", json={"body": "Hi! First draft is ready."})
    client.post(f"/projects/{pid}/messages", json={"body": "Love it"})
    msgs = d.get(f"/projects/{pid}/messages").json()["messages"]
    assert [m["body"] for m in msgs] == ["Hi! First draft is ready.", "Love it"]

    r = client.post(f"/projects/{pid}/decisions", json={"plan_version_no": 1, "decision": "concept_approved"})
    assert r.status_code == 201 and r.json()["decided_role"] == "client"
    assert client.post(f"/projects/{pid}/decisions", json={"plan_version_no": 1, "decision": "approved_for_construction"}).status_code == 422


def test_branding_validation_logo_and_public_lookup():
    owner, s = designer_with_studio()
    r = owner.put("/studio/branding", json={"display_name": "Casa", "primary_color": "#112233", "font": "lora"})
    assert r.status_code == 200 and r.json()["primary_color"] == "#112233"
    for bad in ({"primary_color": "red"}, {"accent_color": "#12345"}, {"primary_color": "#112233;}body{x"}, {"font": "comic"},
                {"template": "../x"}):
        assert owner.put("/studio/branding", json=bad).status_code == 422
    files = {"file": ("logo.png", png_bytes(), "image/png")}
    assert owner.post("/studio/branding/logo", files=files).status_code == 200
    pub = new_client().get(f"/public/studios/{s['slug']}").json()
    assert pub["display_name"] == "Casa" and pub["logo_url"] and "studio_id" not in pub
    logo = new_client().get(pub["logo_url"])
    assert logo.status_code == 200 and logo.headers["content-type"] == "image/png"
    designer_tok = owner.post("/invitations", json={"role": "designer"}).json()["token"]
    des = new_client()
    des.post(f"/public/invitations/{designer_tok}/accept", json={"email": f"{uniq()}@example.com", "password": "designer-pass-1"})
    assert des.put("/studio/branding", json={"display_name": "Hijack"}).status_code == 403
    events = [e["action"] for e in owner.get("/studio/audit").json()["events"]]
    assert {"branding.update", "branding.logo", "studio.create", "invitation.create", "invitation.accept", "credits.grant"} <= set(events)


def test_uploads_are_verified():
    d, _ = designer_with_studio()
    pid = create_project(d)["id"]
    ok = d.post(f"/projects/{pid}/uploads", files={"file": ("a.png", png_bytes(), "image/png")})
    assert ok.status_code == 201 and ok.json()["width"] == 40
    assert d.get(ok.json()["url"]).content[:4] == b"\x89PNG"
    fake = d.post(f"/projects/{pid}/uploads", files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")})
    assert fake.status_code == 400 and fake.json()["error"]["code"] == "invalid_image"
    assert d.post(f"/projects/{pid}/uploads", files={"file": ("e.png", b"", "image/png")}).status_code == 400
    big = b"\x89PNG" + b"0" * (10 * 1024 * 1024 + 10)
    assert d.post(f"/projects/{pid}/uploads", files={"file": ("big.png", big, "image/png")}).status_code == 413
    mb = d.post(f"/projects/{pid}/moodboards", json={"name": "Calm"}).json()
    assert d.post(f"/projects/{pid}/moodboards/{mb['id']}/items", json={"kind": "upload", "ref": ok.json()["id"]}).status_code == 201
    assert d.post(f"/projects/{pid}/moodboards/{mb['id']}/items", json={"kind": "catalog", "ref": "sofa-3"}).status_code == 201
    assert d.post(f"/projects/{pid}/moodboards/{mb['id']}/items", json={"kind": "catalog", "ref": "nope"}).status_code == 422
    assert d.post(f"/projects/{pid}/moodboards/{mb['id']}/items", json={"kind": "color", "ref": "#abcdef"}).status_code == 201
    items = d.get(f"/projects/{pid}/moodboards/{mb['id']}").json()["items"]
    assert len(items) == 3 and items[0]["image_url"]


def test_dossier_snapshot_escaped_with_csp():
    d, _ = designer_with_studio()
    pid = create_project(d, geometry(room_name="<script>alert(1)</script>"), name="<b>Flat</b>")["id"]
    d.put(f"/projects/{pid}/brief", json={"styles": ["modern"], "notes": "<img src=x onerror=alert(1)>", "budget": {"max": 5000}})
    d.post(f"/projects/{pid}/alternatives", json={"name": "Warm", "style_key": "japandi"})
    d.post(f"/projects/{pid}/renders", json={})
    while worker.run_once():
        pass
    r = d.post(f"/projects/{pid}/dossiers", json={"note": "First concept"})
    assert r.status_code == 201 and r.json()["caveat"]
    html = d.get(r.json()["html_url"])
    assert html.status_code == 200 and html.headers["content-type"].startswith("text/html")
    csp = html.headers["content-security-policy"]
    assert "default-src 'none'" in csp and "script-src" not in csp
    body = html.text
    assert "<script>" not in body and "&lt;script&gt;" in body and "<img src=x" not in body and "&lt;b&gt;Flat" in body
    assert "non-binding" in body and "qualified professional" in body and "Plan version 1" in body
    assert "data:image/jpeg;base64," in body  # render thumbnail embedded
    client, _ = invite_client(d, pid)
    assert client.get(r.json()["html_url"]).status_code == 200
    assert client.post(f"/projects/{pid}/dossiers", json={}).status_code == 403
    # snapshot is immutable: later plan changes do not alter it
    d.post(f"/projects/{pid}/plan/versions", json={"geometry": geometry(sofa_x=2000)})
    assert d.get(r.json()["html_url"]).text == body
