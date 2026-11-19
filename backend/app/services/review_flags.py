"""Version diff + professional-review flags (FR-19). Furniture changes never flag; walls, openings,
structural elements and wet rooms (kitchen/bathroom, incl. their fixtures) do."""
from .geometry import EMPTY, WET_KINDS, room_of

CATEGORIES = ("walls", "openings", "rooms", "fixtures", "furniture")


def diff(old: dict | None, new: dict) -> dict:
    old = old or EMPTY
    result = {}
    for cat in CATEGORIES:
        a = {e["id"]: e for e in old.get(cat, [])}
        b = {e["id"]: e for e in new.get(cat, [])}
        result[cat] = {
            "added": sorted(set(b) - set(a)),
            "removed": sorted(set(a) - set(b)),
            "changed": sorted(i for i in set(a) & set(b) if a[i] != b[i]),
        }
    return result


def compute_flags(old: dict | None, new: dict) -> list[dict]:
    if old is None or not old.get("walls"):
        return []  # the first drawn layout is the baseline of existing conditions
    d = diff(old, new)
    old_by = {cat: {e["id"]: e for e in old[cat]} for cat in CATEGORIES}
    new_by = {cat: {e["id"]: e for e in new[cat]} for cat in CATEGORIES}
    flags = []

    def add(category, element_id, change, reason):
        flags.append({"category": category, "element_id": element_id, "change": change, "reason": reason})

    for change in ("added", "removed", "changed"):
        for wid in d["walls"][change]:
            w = new_by["walls"].get(wid) or old_by["walls"][wid]
            was = old_by["walls"].get(wid, {})
            if w.get("structural") or was.get("structural"):
                add("structural", wid, change, "structural / load-bearing wall changed")
            else:
                add("wall", wid, change, "partition wall changed")
        for oid in d["openings"][change]:
            add("opening", oid, change, "door/window opening changed")
        for rid in d["rooms"][change]:
            r_new, r_old = new_by["rooms"].get(rid), old_by["rooms"].get(rid)
            kinds = {r["kind"] for r in (r_new, r_old) if r}
            wet = kinds & set(WET_KINDS)
            # renaming a room is not a building change; only kind/polygon matter
            if change == "changed" and r_new["kind"] == r_old["kind"] and r_new["polygon"] == r_old["polygon"]:
                continue
            for k in sorted(wet):
                add(k, rid, change, f"{k} layout changed (plumbing/ventilation)")
        for fid in d["fixtures"][change]:
            f = new_by["fixtures"].get(fid) or old_by["fixtures"][fid]
            room = room_of(f, new["rooms"]) or room_of(f, old["rooms"])
            cat = room["kind"] if room and room["kind"] in WET_KINDS else (
                "kitchen" if f["kind"] in ("stove", "fridge", "counter", "dishwasher") else "bathroom")
            add(cat, fid, change, f"{f['kind']} fixture changed (plumbing/electrical)")
    return flags
