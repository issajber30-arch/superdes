"""Client helper library: short articles on the app, pricing and design, matched to a question by keywords.
Articles live in library/*.json; answers may use $estimate_low $estimate_high $currency $budget_max."""
import json
import pathlib
import re
from functools import lru_cache
from string import Template

DIR = pathlib.Path(__file__).with_name("library")
TOPICS = {"app": "App help", "pricing": "Pricing", "design": "Design guide"}


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


@lru_cache
def load() -> list[dict]:
    arts = []
    for topic in TOPICS:
        for a in json.loads((DIR / f"{topic}.json").read_text(encoding="utf-8")):
            arts.append({**a, "topic": topic, "_kw": [tuple(_words(k)) for k in a["keywords"]]})
    return arts


def _hits(words: list[str], kw: tuple) -> bool:
    n = len(kw)
    return any(tuple(words[i:i + n]) == kw for i in range(len(words) - n + 1))


def match(message: str, limit: int = 3) -> list[dict]:
    """Best-first articles with at least one whole-word keyword hit; longer keywords weigh more."""
    words = _words(message)
    scored = []
    for a in load():
        score = sum(len(kw) for kw in a["_kw"] if kw and _hits(words, kw))
        if score:
            scored.append((score, a))
    scored.sort(key=lambda t: (-t[0], t[1]["id"]))
    return [a for _, a in scored[:limit]]


def values(ctx: dict) -> dict:
    """Template values from the consultant context; empty when the context has no estimate."""
    if "estimate_totals" not in ctx:
        return {}
    est, cur = ctx["estimate_totals"], ctx["currency"]
    bmax = ((ctx.get("brief") or {}).get("budget") or {}).get("max")
    rng = (f"{est['low']:.0f} to {est['high']:.0f} {cur}" if est["high"] else
           "not available yet - add furniture and finishes to see a range")
    return {"estimate_low": f"{est['low']:.0f}", "estimate_high": f"{est['high']:.0f}", "currency": cur, "estimate_range": rng,
            "budget_max": f"{bmax:.0f} {cur}" if bmax is not None else "not set"}


def render(article: dict, values: dict) -> str:
    # Only the article text is a template; user text never is.
    body = Template(article["answer"]).safe_substitute(values)
    return f"{body}\n\nSource: {TOPICS[article['topic']]} › {article['title']}"
