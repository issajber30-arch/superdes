"""Render queue worker: render_jobs is a Postgres queue claimed with FOR UPDATE SKIP LOCKED
(inside the render_claim_next() SECURITY DEFINER function); all other work runs under tenant RLS."""
import asyncio
import hashlib
import logging
import time

from ...config import settings
from ...db import tenant_tx
from .. import audit, credits, storage
from ..geometry import bbox, room_of
from .concept import ConceptRenderer

log = logging.getLogger("render")
DEFAULT_PALETTE = {"floor": "#d9c4a3", "wall": "#f4f1ec", "accent": "#7a9e9f", "furniture": "#b8a68c"}


def get_renderer():
    if settings.comfyui_url:
        from .comfyui import ComfyUIRenderer

        return ComfyUIRenderer(settings.comfyui_url)
    return ConceptRenderer()


def build_scene(conn, job: dict) -> dict:
    v = conn.execute("select version_no, geometry from plan_versions where id = %s", (job["plan_version_id"],)).fetchone()
    geom, view = v["geometry"], job["view"]
    room = next((r for r in geom["rooms"] if r["id"] == view.get("room_id")), None) or (geom["rooms"][0] if geom["rooms"] else None)
    if room:
        poly = room["polygon"]
    else:
        pts = [p for w in geom["walls"] for p in (w["a"], w["b"])] or [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]
        poly = [[bbox(pts)[0], bbox(pts)[1]], [bbox(pts)[2], bbox(pts)[1]], [bbox(pts)[2], bbox(pts)[3]], [bbox(pts)[0], bbox(pts)[3]]]
    bb = bbox(poly)
    style_key = view.get("style") or "scandinavian"
    style = conn.execute("select name, palette from styles where key = %s", (style_key,)).fetchone() or {"name": style_key, "palette": DEFAULT_PALETTE}
    pal = {**DEFAULT_PALETTE, **style["palette"]}
    colors = {"floor": pal["floor"], "wall": pal["wall"]}
    if room:
        for s in conn.execute("select s.surface, f.color from finish_selections s join finishes f on f.key = s.finish_key "
                              "where s.project_id = %s and s.room_id = %s", (job["project_id"], room["id"])).fetchall():
            colors[s["surface"]] = s["color"]
    items = [it for it in geom["furniture"] + [dict(fx, catalog_key=fx["kind"]) for fx in geom["fixtures"]]
             if (room_of(it, [room]) if room else True)]
    cat = {r["key"]: r for r in conn.execute("select key, name, height_mm from catalog_items where key = any(%s)",
                                             ([i["catalog_key"] for i in items],)).fetchall()}
    furniture = [{"x": i["x"], "y": i["y"], "w": i["w"], "d": i["d"], "rot": i["rot"],
                  "h": cat.get(i["catalog_key"], {}).get("height_mm", 800), "name": cat.get(i["catalog_key"], {}).get("name", i["catalog_key"])}
                 for i in items]
    walls = {w["id"]: w for w in geom["walls"]}
    openings = []
    for o in geom["openings"]:
        w = walls[o["wall_id"]]
        (ax, ay), (bx, by) = w["a"], w["b"]
        length = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        dx, dy = (bx - ax) / length, (by - ay) / length
        a = [ax + dx * o["offset"], ay + dy * o["offset"]]
        b = [a[0] + dx * o["width"], a[1] + dy * o["width"]]
        if bb[0] - 400 <= a[0] <= bb[2] + 400 and bb[1] - 400 <= a[1] <= bb[3] + 400:
            openings.append({"kind": o["kind"], "a": a, "b": b})
    seed = int(hashlib.sha256(str(job["id"]).encode()).hexdigest()[:8], 16)
    return {"version_no": v["version_no"], "angle": view.get("angle", "front"), "room": {"bbox": bb},
            "room_label": (room["name"] or room["kind"]) if room else "whole plan", "room_kind": room["kind"] if room else "room",
            "style_name": style["name"], "floor_color": colors["floor"], "wall_color": colors["wall"],
            "accent_color": pal["accent"], "furniture_color": pal["furniture"], "furniture": furniture, "openings": openings, "seed": seed,
            "camera": view.get("camera") if room else None}


def run_once(renderer=None) -> bool:
    """Process one queued job. Returns False when the queue is empty."""
    with tenant_tx() as conn:
        claimed = conn.execute("select * from render_claim_next()").fetchone()
    if not claimed:
        return False
    uid, sid, jid = claimed["requested_by"], claimed["studio_id"], claimed["id"]
    try:
        with tenant_tx(uid, sid) as conn:
            job = conn.execute("select * from render_jobs where id = %s", (jid,)).fetchone()
            scene = build_scene(conn, job)
        png = (renderer or get_renderer()).render(scene)
        with tenant_tx(uid, sid) as conn:
            up = storage.store_image(conn, sid, claimed["project_id"], uid, png, "render", f"render-{jid}.png")
            conn.execute("update render_jobs set status = 'succeeded', result_upload_id = %s, finished_at = now() where id = %s",
                         (up["id"], jid))
            audit.log(conn, "render.succeeded", sid, uid, "render_job", jid)
    except Exception as e:  # any renderer failure -> job failed + credit refunded
        log.warning("render %s failed", jid, exc_info=e)  # details stay server-side
        fail_job(uid, sid, jid)
    return True


def fail_job(uid, sid, jid):
    with tenant_tx(uid, sid) as conn:
        conn.execute("update render_jobs set status = 'failed', error = %s, finished_at = now() where id = %s",
                     ("Render failed. Your credit was refunded; please try again.", jid))
        credits.refund_render(conn, sid, uid, jid)  # idempotent: skips if already refunded
        audit.log(conn, "render.failed", sid, uid, "render_job", jid)


def reap_stale(minutes: int = 10):
    """Fail + refund jobs left 'running' by a worker that died mid-render (crash, OOM, restart)."""
    with tenant_tx() as conn:
        stale = conn.execute("select * from render_stale_jobs(%s)", (minutes,)).fetchall()
    for j in stale:
        log.warning("render %s stuck in running, failing it", j["id"])
        fail_job(j["requested_by"], j["studio_id"], j["id"])


async def worker_loop(stop: asyncio.Event):
    last_reap = 0.0
    while not stop.is_set():
        try:
            if time.monotonic() - last_reap > 60:
                last_reap = time.monotonic()
                await asyncio.to_thread(reap_stale)
            busy = await asyncio.to_thread(run_once)
        except Exception:
            log.exception("render worker error")
            busy = False
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.render_poll_seconds)
            except TimeoutError:
                pass
