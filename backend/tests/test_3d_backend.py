"""3D stages 4-5: dossier 3D views and concept renders from a 3D camera."""
import base64
import io

from PIL import Image

from app.services.render.concept import ConceptRenderer
from tests.conftest import create_project, designer_with_studio
from tests.test_renders import run_all


def data_url(fmt="PNG", size=(320, 200), color=(120, 140, 160)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, fmt)
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif"}[fmt]
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode()


# ---------- stage 5: dossier views ----------
def test_dossier_embeds_3d_views_reencoded():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    r = c.post(f"/projects/{pid}/dossiers", json={"views": [data_url(), data_url("JPEG")]})
    assert r.status_code == 201, r.text
    html = c.get(r.json()["html_url"]).text
    assert html.count('alt="3D view') == 2
    assert html.count("data:image/jpeg;base64,") >= 2  # re-encoded, never the raw upload
    assert data_url() not in html


def test_dossier_without_views_has_no_3d_section():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    html = c.get(c.post(f"/projects/{pid}/dossiers", json={}).json()["html_url"]).text
    assert 'alt="3D view' not in html


def test_dossier_rejects_bad_views():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    bad = [
        ["data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode()],
        ["data:image/png;base64,@@@not-base64@@@"],
        ["https://example.com/x.png"],
        [data_url("GIF")],
        ["data:image/png;base64," + base64.b64encode(b"not an image").decode()],
        [data_url()] * 5,
        ["x" * 3_000_001],
    ]
    for views in bad:
        r = c.post(f"/projects/{pid}/dossiers", json={"views": views})
        assert r.status_code == 422, (views[0][:40], r.status_code, r.text[:200])
    assert c.get(f"/projects/{pid}/dossiers").json()["dossiers"] == []


def test_dossier_rejects_pixel_bomb():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    buf = io.BytesIO()
    Image.new("1", (9000, 9000)).save(buf, "PNG")  # 81 MP, tiny file
    r = c.post(f"/projects/{pid}/dossiers", json={"views": ["data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()]})
    assert r.status_code == 422


# ---------- stage 4: render from a 3D camera ----------
SCENE = {"version_no": 1, "angle": "front", "room": {"bbox": (0, 0, 5000, 4000)}, "room_label": "Living", "room_kind": "living",
         "style_name": "Modern", "floor_color": "#a9a39b", "wall_color": "#efefef", "accent_color": "#1f3a5f",
         "furniture_color": "#55575a", "seed": 1,
         "furniture": [{"x": 1000, "y": 2800, "w": 2100, "d": 900, "rot": 0, "h": 850, "name": "Sofa"}],
         "openings": [{"kind": "window", "a": [1500, 0], "b": [2700, 0]}, {"kind": "door", "a": [0, 500], "b": [0, 1400]}]}


def test_camera_render_is_png_and_deterministic():
    r = ConceptRenderer()
    for cam in ({"x": 2500, "y": 3500, "yaw": -90}, {"x": 300, "y": 300, "yaw": 45}, {"x": 2000, "y": 3200, "yaw": 90},
                {"x": 99999, "y": -99999, "yaw": 360}, {"x": 1500, "y": 3200, "yaw": 0}):  # facing a wall, corner, outside, inside the sofa
        out = r.render({**SCENE, "camera": cam})
        assert out[:8] == b"\x89PNG\r\n\x1a\n"
        assert Image.open(io.BytesIO(out)).size == (1024, 640)
        assert out == r.render({**SCENE, "camera": cam})


def test_camera_clips_what_is_behind_it():
    r = ConceptRenderer()
    cam = {"x": 2500, "y": 1000, "yaw": -90}  # looking north at the window wall; the sofa is behind
    with_sofa = r.render({**SCENE, "camera": cam})
    without = r.render({**SCENE, "camera": cam, "furniture": []})
    assert with_sofa == without
    # turning around shows the sofa
    back = {"x": 2500, "y": 1000, "yaw": 90}
    assert r.render({**SCENE, "camera": back}) != r.render({**SCENE, "camera": back, "furniture": []})


def test_render_api_accepts_camera_and_validates():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    ok = c.post(f"/projects/{pid}/renders", json={"view": {"room_id": "r1", "camera": {"x": 2500, "y": 3500, "yaw": -90}}})
    assert ok.status_code == 202, ok.text
    assert ok.json()["view"]["camera"] == {"x": 2500, "y": 3500, "yaw": -90}
    run_all()
    assert c.get(f"/projects/{pid}/renders/{ok.json()['id']}").json()["status"] == "succeeded"
    for bad in ({"camera": {"x": 1, "y": 1, "yaw": 0}},  # no room
                {"room_id": "r1", "camera": {"x": 1, "y": 1}},
                {"room_id": "r1", "camera": {"x": 1, "y": 1, "yaw": 999}},
                {"room_id": "r1", "camera": {"x": float("1e9"), "y": 1, "yaw": 0}},
                {"room_id": "r1", "camera": {"x": 1, "y": 1, "yaw": 0, "z": 5}}):
        assert c.post(f"/projects/{pid}/renders", json={"view": bad}).status_code == 422, bad
