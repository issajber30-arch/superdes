"""AI design consultant interface. Consultants return advice text + structured suggestions; they never
write geometry or any other project state. Context is built server-side from the authorized project only."""
from typing import Protocol

from ...config import settings
from ..estimates import compute as compute_estimate
from ..geometry import bbox, room_area_m2, room_of
from ..plans import current_version

SUGGESTION_KINDS = ("style", "furniture", "material", "concept", "budget", "layout_note")


class Consultant(Protocol):
    name: str

    def advise(self, context: dict, user_message: str) -> dict:
        """Returns {"message": str, "suggestions": [{"kind","key","title","detail","data"}]}"""


def build_context(conn, project: dict, history: list[dict]) -> dict:
    from ...routers.briefs import load_brief

    v = current_version(conn, project["id"])
    geom = v["geometry"] if v else {"rooms": [], "furniture": [], "walls": [], "openings": [], "fixtures": []}
    rooms = []
    for r in geom["rooms"]:
        x0, y0, x1, y1 = bbox(r["polygon"])
        rooms.append({"id": r["id"], "name": r["name"], "kind": r["kind"], "area_m2": round(room_area_m2(r), 2),
                      "width_mm": round(x1 - x0), "depth_mm": round(y1 - y0),
                      "furniture": [f["catalog_key"] for f in geom["furniture"] if room_of(f, [r])]})
    prefs = conn.execute("select kind, key, decision from ai_preferences where project_id = %s order by created_at",
                         (project["id"],)).fetchall()
    est = compute_estimate(conn, project["id"])
    finishes = conn.execute("select room_id, surface, finish_key from finish_selections where project_id = %s",
                            (project["id"],)).fetchall()
    return {
        "project_name": project["name"],
        "plan_version_no": v["version_no"] if v else None,
        "rooms": rooms,
        "brief": load_brief(conn, project["id"]),
        "finish_selections": finishes,
        "estimate_totals": est["totals"], "currency": est["currency"],
        "preferences": {"accepted": [{"kind": p["kind"], "key": p["key"]} for p in prefs if p["decision"] == "accept"],
                        "rejected": [{"kind": p["kind"], "key": p["key"]} for p in prefs if p["decision"] == "reject"]},
        "history": [{"role": h["role"], "content": h["content"][:1000]} for h in history[-6:]],
        "catalog": {
            "styles": conn.execute("select key, name, description, palette, materials from styles order by key").fetchall(),
            "furniture": conn.execute("select key, name, category, room_kinds, styles, width_mm, depth_mm, height_mm, "
                                      "price_low::float, price_high::float from catalog_items order by key").fetchall(),
            "finishes": conn.execute("select key, name, surface, color, styles, price_low_m2::float, price_high_m2::float "
                                     "from finishes order by key").fetchall(),
        },
    }


def get_consultant() -> Consultant:
    from .rules import RuleBasedConsultant

    if settings.ollama_url:
        from .ollama import OllamaConsultant

        return OllamaConsultant(settings.ollama_url, settings.ollama_model, fallback=RuleBasedConsultant(),
                                api_key=settings.ollama_api_key)
    return RuleBasedConsultant()
