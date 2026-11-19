"""Deterministic, brief-aware fallback consultant (no model needed)."""
import re


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


class RuleBasedConsultant:
    name = "rules"

    def advise(self, ctx: dict, user_message: str) -> dict:
        cat = ctx["catalog"]
        styles = {s["key"]: s for s in cat["styles"]}
        brief = ctx["brief"]
        rejected = {(p["kind"], p["key"]) for p in ctx["preferences"]["rejected"]}
        accepted = [(p["kind"], p["key"]) for p in ctx["preferences"]["accepted"]]
        msg = user_message.lower()

        # --- style choice: brief > accepted prefs > defaults, never a rejected one
        wanted = [_norm(s) for s in brief["styles"]] + [k for kind, k in accepted if kind in ("style", "concept")]
        ranked = [k for k in wanted if k in styles] + [k for k in styles if k in msg] + ["scandinavian", "japandi", "modern"]
        ranked += list(styles)
        order = []
        for k in ranked:
            if k not in order and ("style", k) not in rejected and ("concept", k) not in rejected:
                order.append(k)
        primary = styles[order[0]]

        budget = brief["budget"]
        budget_max = budget.get("max")
        spent_high = ctx["estimate_totals"]["high"]
        remaining = (budget_max - spent_high) if budget_max is not None else None
        tight = budget.get("priority") == "low_cost" or (remaining is not None and remaining < 1000)

        suggestions, lines = [], []
        lines.append(f"Here are ideas for \"{ctx['project_name']}\" based on your brief and the current plan"
                     + (f" (version {ctx['plan_version_no']})." if ctx["plan_version_no"] else "."))

        # palette
        pal = primary["palette"]
        suggestions.append({"kind": "style", "key": primary["key"], "title": f"{primary['name']} palette",
                            "detail": f"{primary['description']} Walls {pal['wall']}, floor {pal['floor']}, accent {pal['accent']}.",
                            "data": {"palette": pal, "materials": primary["materials"]}})
        lines.append(f"Style direction: {primary['name']} - {primary['description']}")
        if brief["colors"]:
            lines.append(f"I kept your colour wishes ({', '.join(brief['colors'][:5])}) as accents against the base palette.")

        # furniture that fits each room
        rooms = ctx["rooms"]
        mentioned = [r for r in rooms if (r["name"] and r["name"].lower() in msg) or r["kind"] in msg]
        target_rooms = mentioned or rooms
        present = {k for r in rooms for k in r["furniture"]}
        furn_count = 0
        for room in target_rooms:
            fits = []
            for item in cat["furniture"]:
                if room["kind"] not in item["room_kinds"] or item["key"] in room["furniture"] or ("furniture", item["key"]) in rejected:
                    continue
                w, d = item["width_mm"], item["depth_mm"]
                rw, rd = room["width_mm"] * 0.6, room["depth_mm"] * 0.6
                if not ((w <= rw and d <= rd) or (d <= rw and w <= rd)):
                    continue
                if tight and remaining is not None and item["price_low"] > max(remaining, 0):
                    continue
                score = (2 if primary["key"] in item["styles"] else 0) + (1 if item["key"] not in present else 0)
                score -= item["price_low"] / 5000 if tight else 0
                fits.append((score, item))
            fits.sort(key=lambda t: (-t[0], t[1]["key"]))
            for _, item in fits[:2]:
                price = f"{item['price_low']:.0f}-{item['price_high']:.0f} {ctx['currency']} (estimate)"
                suggestions.append({"kind": "furniture", "key": item["key"], "title": f"{item['name']} for {room['name'] or room['kind']}",
                                    "detail": f"{item['width_mm']}x{item['depth_mm']} mm fits the {room['width_mm']}x{room['depth_mm']} mm room "
                                              f"with circulation space. {price}.",
                                    "data": {"room_id": room["id"], "width_mm": item["width_mm"], "depth_mm": item["depth_mm"]}})
                furn_count += 1
            if furn_count >= 4:
                break
        if not rooms:
            lines.append("Your plan has no rooms yet - draw at least one room so I can suggest furniture that fits.")
        elif furn_count:
            lines.append(f"I picked {furn_count} piece(s) sized for your rooms (keeping roughly 40% free floor for circulation).")

        # materials
        for surface in ("floor", "wall"):
            opts = [f for f in cat["finishes"] if f["surface"] == surface and ("material", f["key"]) not in rejected]
            opts.sort(key=lambda f: (primary["key"] not in f["styles"], f["price_low_m2"] if tight else -f["price_high_m2"], f["key"]))
            if opts:
                f = opts[0]
                suggestions.append({"kind": "material", "key": f["key"], "title": f"{f['name']} ({surface})",
                                    "detail": f"Suits {primary['name']}; about {f['price_low_m2']:.0f}-{f['price_high_m2']:.0f} "
                                              f"{ctx['currency']}/m2 (estimate).", "data": {"surface": surface, "color": f["color"]}})

        # 2-3 alternative concepts
        for k in order[1:4]:
            s = styles[k]
            suggestions.append({"kind": "concept", "key": k, "title": f"Concept: {s['name']}",
                                "detail": f"{s['description']} Key materials: {', '.join(s['materials'][:3])}.",
                                "data": {"palette": s["palette"]}})
        lines.append("I also outlined alternative concepts you can compare: " + ", ".join(styles[k]["name"] for k in order[1:4]) + ".")

        # budget
        if budget_max is not None:
            status = "within" if spent_high <= budget_max else "above"
            suggestions.append({"kind": "budget", "key": "budget-check", "title": "Budget check",
                                "detail": f"Current estimate range {ctx['estimate_totals']['low']:.0f}-{spent_high:.0f} "
                                          f"{ctx['currency']} is {status} your maximum of {budget_max:.0f}. Estimates are non-binding.",
                                "data": {"budget_max": budget_max, "estimate_high": spent_high}})
            if status == "above":
                lines.append("Your estimate is above budget - consider fewer statement pieces or lower-cost finishes.")
        if brief["household"].get("children") or brief["household"].get("pets"):
            suggestions.append({"kind": "layout_note", "key": "durable-finishes", "title": "Family/pet-friendly choices",
                                "detail": "Prefer washable fabrics, rounded table edges and scratch-resistant floors.", "data": {}})
        lines.append("These are suggestions only - nothing has been changed in your plan.")
        return {"message": "\n".join(lines), "suggestions": suggestions[:10]}
