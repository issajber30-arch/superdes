"""Estimate lines: auto-generated from the current plan's furniture and finish selections x room area,
with stored overrides (source='override', keyed by item_key) and manual lines (source='manual')."""
from collections import defaultdict
from decimal import Decimal

from ..config import ESTIMATE_BASIS, ESTIMATE_DISCLAIMER, settings
from .geometry import room_area_m2, room_of, room_perimeter_m
from .plans import current_version

WALL_HEIGHT_M = 2.6


def _num(v) -> float | None:
    return None if v is None else float(v)


def compute(conn, project_id) -> dict:
    v = current_version(conn, project_id)
    geom = v["geometry"] if v else {"rooms": [], "furniture": []}
    rooms = {r["id"]: r for r in geom["rooms"]}
    items = []

    groups = defaultdict(list)
    for f in geom["furniture"]:
        groups[f["catalog_key"]].append(f)
    catalog = {r["key"]: r for r in conn.execute("select * from catalog_items where key = any(%s)", (list(groups),)).fetchall()}
    for key, pieces in sorted(groups.items()):
        c = catalog.get(key)
        room_names = sorted({(room_of(p, geom["rooms"]) or {}).get("name") or "unassigned" for p in pieces})
        items.append({"item_key": f"furn:{key}", "source": "auto", "category": c["category"] if c else "custom",
                      "label": c["name"] if c else (pieces[0].get("label") or key), "qty": float(len(pieces)), "unit": "pcs",
                      "unit_low": _num(c["price_low"]) if c else 0.0, "unit_high": _num(c["price_high"]) if c else 0.0,
                      "rooms": room_names, "note": "" if c else "not in catalog; add a price override"})

    sels = conn.execute("select s.room_id, s.surface, f.key, f.name, f.price_low_m2, f.price_high_m2 from finish_selections s "
                        "join finishes f on f.key = s.finish_key where s.project_id = %s order by s.room_id, s.surface",
                        (project_id,)).fetchall()
    for s in sels:
        room = rooms.get(s["room_id"])
        if not room:
            continue  # room removed from the current plan; selection is stale
        qty = room_area_m2(room) if s["surface"] == "floor" else room_perimeter_m(room) * WALL_HEIGHT_M
        items.append({"item_key": f"finish:{s['room_id']}:{s['surface']}", "source": "auto", "category": f"finish_{s['surface']}",
                      "label": f"{s['name']} ({room['name'] or room['kind']}, {s['surface']})", "qty": round(qty, 2), "unit": "m2",
                      "unit_low": _num(s["price_low_m2"]), "unit_high": _num(s["price_high_m2"]), "rooms": [room["name"] or room["kind"]],
                      "note": "wall area = perimeter x 2.6 m, openings not deducted" if s["surface"] == "wall" else ""})

    stored = conn.execute("select * from estimate_items where project_id = %s order by updated_at", (project_id,)).fetchall()
    overrides = {r["item_key"]: r for r in stored if r["source"] == "override"}
    for it in items:
        o = overrides.get(it["item_key"])
        it["overridden"] = bool(o)
        it["excluded"] = bool(o and o["excluded"])
        if o:
            for k in ("qty", "unit_low", "unit_high"):
                if o[k] is not None:
                    it[k] = float(o[k])
            if o["label"]:
                it["label"] = o["label"]
    for m in stored:
        if m["source"] == "manual":
            items.append({"id": m["id"], "item_key": m["item_key"], "source": "manual", "category": "manual", "label": m["label"],
                          "qty": _num(m["qty"]) or 0.0, "unit": m["unit"], "unit_low": _num(m["unit_low"]) or 0.0,
                          "unit_high": _num(m["unit_high"]) or 0.0, "rooms": [], "note": "", "overridden": False,
                          "excluded": m["excluded"]})

    low = high = Decimal(0)
    for it in items:
        it["total_low"] = round(it["qty"] * it["unit_low"], 2)
        it["total_high"] = round(it["qty"] * it["unit_high"], 2)
        if not it["excluded"]:
            low += Decimal(str(it["total_low"]))
            high += Decimal(str(it["total_high"]))
    return {"items": items, "totals": {"low": float(low), "high": float(high)}, "currency": settings.currency,
            "plan_version_no": v["version_no"] if v else None, "basis": ESTIMATE_BASIS, "non_binding": True,
            "label": "Estimate - non-binding", "disclaimer": ESTIMATE_DISCLAIMER}
