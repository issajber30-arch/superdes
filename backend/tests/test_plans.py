from tests.conftest import create_project, designer_with_studio, geometry, invite_client


def test_versions_flags_and_review():
    c, _ = designer_with_studio()
    p = create_project(c)
    base = f"/projects/{p['id']}/plan"
    v1 = c.get(base).json()
    assert v1["current_version"]["version_no"] == 1 and v1["current_version"]["review_status"] == "conceptual"
    assert "qualified professional" in v1["caveat"]

    # moving a sofa: not flagged
    r = c.post(f"{base}/versions", json={"geometry": geometry(sofa_x=1500), "label": "move sofa", "base_version_no": 1})
    assert r.status_code == 201, r.text
    v2 = r.json()
    assert v2["version_no"] == 2 and v2["review_status"] == "conceptual" and v2["review_flags"] == []
    assert v2["author_role"] == "owner" and v2["label"] == "move sofa" and v2["caveat"]

    # moving a structural wall (w1 end moves, so w2 too): flagged provisional
    r = c.post(f"{base}/versions", json={"geometry": geometry(sofa_x=1500, wall_x=5600)})
    v3 = r.json()
    assert v3["review_status"] == "provisional"
    cats = {(f["category"], f["element_id"]) for f in v3["review_flags"]}
    assert ("structural", "w1") in cats and ("wall", "w2") in cats

    # moving a door: flagged as opening; unreviewed flags carry forward
    g4 = geometry(sofa_x=1500, wall_x=5600, door_offset=1200)
    v4 = c.post(f"{base}/versions", json={"geometry": g4}).json()
    cats4 = {(f["category"], f["element_id"]) for f in v4["review_flags"]}
    assert ("opening", "o1") in cats4 and ("structural", "w1") in cats4

    # stale base version -> 409
    r = c.post(f"{base}/versions", json={"geometry": g4, "base_version_no": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"

    # mark reviewed: back to conceptual (never 'approved')
    r = c.post(f"{base}/versions/4/review", json={"note": "checked with engineer"})
    assert r.status_code == 200 and r.json()["review_status"] == "conceptual" and r.json()["reviewed_by"]
    v5 = c.post(f"{base}/versions", json={"geometry": g4}).json()
    assert v5["review_status"] == "conceptual" and v5["review_flags"] == []

    # list, get, compare; old versions immutable & retrievable
    vers = c.get(f"{base}/versions").json()["versions"]
    assert [v["version_no"] for v in vers] == [5, 4, 3, 2, 1]
    assert c.get(f"{base}/versions/1").json()["geometry"]["furniture"][0]["x"] == 1000
    assert c.get(f"{base}/versions/99").status_code == 404
    cmp = c.get(f"{base}/compare", params={"from": 1, "to": 3}).json()
    assert cmp["diff"]["walls"]["changed"] == ["w1", "w2", "w3"] and cmp["diff"]["furniture"]["changed"] == ["f1"]
    assert any(f["category"] == "structural" for f in cmp["flags"])
    decisions = c.get(f"/projects/{p['id']}/decisions").json()["decisions"]
    assert decisions[0]["decision"] == "reviewed"


def test_wet_room_changes_flag():
    c, _ = designer_with_studio()
    g = geometry()
    g["rooms"].append({"id": "r2", "name": "Bath", "kind": "bathroom", "polygon": [[5000, 0], [7000, 0], [7000, 2000], [5000, 2000]]})
    g["fixtures"].append({"id": "x1", "kind": "toilet", "x": 5200, "y": 200, "w": 380, "d": 650})
    p = create_project(c, g)
    g["fixtures"][0]["x"] = 6000
    v = c.post(f"/projects/{p['id']}/plan/versions", json={"geometry": g}).json()
    assert v["review_status"] == "provisional" and v["review_flags"][0]["category"] == "bathroom"


def test_client_saves_version_and_cannot_review():
    c, _ = designer_with_studio()
    p = create_project(c)
    client, _ = invite_client(c, p["id"])
    v = client.post(f"/projects/{p['id']}/plan/versions", json={"geometry": geometry(sofa_x=1200)}).json()
    assert v["author_role"] == "client" and v["version_no"] == 2
    assert client.post(f"/projects/{p['id']}/plan/versions/2/review", json={}).status_code == 403
    assert client.post("/projects", json={"name": "nope"}).status_code == 403


def test_first_drawn_layout_is_baseline():
    c, _ = designer_with_studio()
    p = create_project(c, {})
    v = c.post(f"/projects/{p['id']}/plan/versions", json={"geometry": geometry()}).json()
    assert v["version_no"] == 2 and v["review_status"] == "conceptual"
