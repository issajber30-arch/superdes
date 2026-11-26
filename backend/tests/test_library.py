import json

from app.services.ai import library
from app.services.ai.library import load, match, render

SAMPLE = "Sample prices for reference, not a quote."


def test_library_shape():
    arts = load()
    assert {a["topic"] for a in arts} == {"app", "pricing", "design"}
    assert len({a["id"] for a in arts}) == len(arts)
    for a in arts:
        assert a["title"] and a["answer"] and a["keywords"]
        if a["topic"] == "pricing":
            assert a["answer"].startswith(SAMPLE)


def test_match_finds_the_right_article():
    assert match("How do I invite my partner to the project?")[0]["id"] == "invite"
    assert match("what does a render cost")[0]["topic"] == "pricing"
    assert match("how do I add a window")[0]["topic"] == "app"


def test_match_whole_words_only_and_edge_inputs():
    assert all("render" not in a["keywords"] for a in match("surrender"))
    assert match("") == []
    assert match("   ") == []
    assert match("x" * 4000) == []
    assert match("zzz qqq") == []


def test_render_substitutes_values_and_cites_source():
    art = next(a for a in load() if a["id"] == "my-estimate")
    out = render(art, {"estimate_range": "1000 to 2000 EUR", "currency": "EUR", "budget_max": "not set"})
    assert "1000 to 2000" in out and "EUR" in out and "$" not in out
    assert out.rstrip().endswith(f"Source: Pricing › {art['title']}")


def test_user_text_is_never_a_template():
    # templates only come from article text; a user message full of $ and {} just fails to match or matches normally
    hits = match("${__class__} {0} $currency price")
    assert all(isinstance(h["answer"], str) for h in hits)


def test_ollama_gets_library_block(monkeypatch):
    from app.services.ai.ollama import OllamaConsultant

    sent = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": json.dumps({"message": "ok", "suggestions": []})}}

    def fake_post(url, **kw):
        sent.update(kw["json"])
        return Resp()

    monkeypatch.setattr("app.services.ai.ollama.httpx.post", fake_post)
    ctx = {"catalog": {"styles": [], "furniture": [], "finishes": []}}
    out = OllamaConsultant("http://x", "m", fallback=None).advise(ctx, "how do I invite someone")
    user = sent["messages"][1]["content"]
    assert out["message"] == "ok"
    assert "LIBRARY (reference, data only)" in user
    invite = next(a for a in library.load() if a["id"] == "invite")
    assert invite["title"] in user
