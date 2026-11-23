import io

import pytest
from PIL import Image

from app.services.render import worker
from app.services.render.concept import ConceptRenderer
from tests.conftest import admin_sql, create_project, designer_with_studio, geometry


def run_all(renderer=None):
    while worker.run_once(renderer):
        pass


def balance(c):
    return c.get("/studio/credits").json()["balance"]


def test_render_tracks_plan_versions():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    r = c.post(f"/projects/{pid}/renders", json={"view": {"room_id": "r1", "angle": "corner-ne", "style": "japandi"}})
    assert r.status_code == 202, r.text
    j1 = r.json()
    assert j1["plan_version_no"] == 1 and j1["status"] == "queued" and j1["caveat"]
    run_all()
    j1 = c.get(f"/projects/{pid}/renders/{j1['id']}").json()
    assert j1["status"] == "succeeded" and j1["result_url"]

    c.post(f"/projects/{pid}/plan/versions", json={"geometry": geometry(sofa_x=1800)})
    j2 = c.post(f"/projects/{pid}/renders", json={"view": {"room_id": "r1"}}).json()
    assert j2["plan_version_no"] == 2
    run_all()
    img1 = c.get(j1["result_url"])
    assert img1.status_code == 200 and img1.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(img1.content)).size == (1024, 640)
    assert c.get(c.get(f"/projects/{pid}/renders/{j2['id']}").json()["result_url"]).status_code == 200
    assert [x["plan_version_no"] for x in c.get(f"/projects/{pid}/renders").json()["renders"]] == [2, 1]
    # pinned to an older version explicitly
    assert c.post(f"/projects/{pid}/renders", json={"plan_version_no": 1}).json()["plan_version_no"] == 1
    assert c.post(f"/projects/{pid}/renders", json={"view": {"room_id": "nope"}}).status_code == 422
    assert c.post(f"/projects/{pid}/renders", json={"view": {"angle": "top"}}).status_code == 422


def test_credit_idempotency_refund_and_402(caplog):
    c, s = designer_with_studio()
    pid = create_project(c)["id"]
    assert balance(c) == 50
    a = c.post(f"/projects/{pid}/renders", json={"idempotency_key": "k-1"})
    b = c.post(f"/projects/{pid}/renders", json={"idempotency_key": "k-1"})
    assert a.status_code == 202 and b.status_code == 200 and b.json()["replayed"] and a.json()["id"] == b.json()["id"]
    assert balance(c) == 49

    class Boom:
        def render(self, scene):
            raise RuntimeError("GPU on fire")

    run_all(Boom())
    j = c.get(f"/projects/{pid}/renders/{a.json()['id']}").json()
    # users get a generic message; the details are only in the server log
    assert j["status"] == "failed" and "GPU on fire" not in j["error"] and j["error"].startswith("Render failed")
    assert "GPU on fire" in caplog.text
    assert balance(c) == 50
    reasons = [e["reason"] for e in c.get("/studio/credits").json()["ledger"]]
    assert reasons.count("render_refund") == 1

    # drain credits -> 402, and no job is created
    sid = c.get("/studio").json()["studio"]["id"]
    admin_sql("insert into credit_ledger (studio_id, delta, reason) values (%s, -50, 'test_drain')", (sid,))
    r = c.post(f"/projects/{pid}/renders", json={"idempotency_key": "k-2"})
    assert r.status_code == 402 and r.json()["error"]["code"] == "insufficient_credits"
    assert len(c.get(f"/projects/{pid}/renders").json()["renders"]) == 1
    # replay of an existing key still works without credits
    assert c.post(f"/projects/{pid}/renders", json={"idempotency_key": "k-1"}).status_code == 200


def test_concept_renderer_is_deterministic():
    scene = {"version_no": 3, "angle": "front", "room": {"bbox": (0, 0, 5000, 4000)}, "room_label": "Living", "room_kind": "living",
             "style_name": "Modern", "floor_color": "#a9a39b", "wall_color": "#efefef", "accent_color": "#1f3a5f",
             "furniture_color": "#55575a", "seed": 1,
             "furniture": [{"x": 1000, "y": 2800, "w": 2100, "d": 900, "rot": 0, "h": 850, "name": "Sofa"},
                           {"x": 1500, "y": 1800, "w": 1100, "d": 600, "rot": 30, "h": 420, "name": "Table"}],
             "openings": [{"kind": "window", "a": [1500, 0], "b": [2700, 0]}, {"kind": "door", "a": [0, 500], "b": [0, 1400]}]}
    r = ConceptRenderer()
    for angle in ("front", "back", "left", "right", "corner-ne", "corner-nw", "corner-se", "corner-sw"):
        out = r.render({**scene, "angle": angle})
        assert out[:8] == b"\x89PNG\r\n\x1a\n"
        assert out == r.render({**scene, "angle": angle})


@pytest.mark.parametrize("geom", [{}, None])
def test_render_empty_plan(geom):
    c, _ = designer_with_studio()
    pid = create_project(c, geom if geom is not None else {"walls": [{"id": "w", "a": [0, 0], "b": [3000, 0]}]})["id"]
    jid = c.post(f"/projects/{pid}/renders", json={}).json()["id"]
    run_all()
    assert c.get(f"/projects/{pid}/renders/{jid}").json()["status"] == "succeeded"


def test_stale_running_job_is_failed_and_refunded_once():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    stale = c.post(f"/projects/{pid}/renders", json={}).json()["id"]
    fresh = c.post(f"/projects/{pid}/renders", json={}).json()["id"]
    assert balance(c) == 48
    # simulate a worker that died mid-render, and one that is still working
    admin_sql("update render_jobs set status = 'running', started_at = now() - interval '1 hour' where id = %s", (stale,))
    admin_sql("update render_jobs set status = 'running', started_at = now() - interval '1 minute' where id = %s", (fresh,))
    worker.reap_stale()
    worker.reap_stale()  # second sweep must not refund again
    assert c.get(f"/projects/{pid}/renders/{stale}").json()["status"] == "failed"
    assert c.get(f"/projects/{pid}/renders/{fresh}").json()["status"] == "running"
    assert balance(c) == 49
    assert [e["reason"] for e in c.get("/studio/credits").json()["ledger"]].count("render_refund") == 1
