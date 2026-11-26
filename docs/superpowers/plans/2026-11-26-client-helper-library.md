# Client Helper Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project consultant answers app, pricing and design questions from a keyword library, with no new model.

**Architecture:** JSON articles + a stdlib matcher in `services/ai/library.py`; `RuleBasedConsultant.advise` routes app/pricing matches to the article and keeps design advice otherwise; `OllamaConsultant` gets the top matches as a separate LIBRARY block.

**Tech Stack:** Python 3 / FastAPI / psycopg, vanilla JS, pytest against local Postgres.

**Spec:** `docs/superpowers/specs/2026-11-26-client-helper-library-design.md`

## Global Constraints
- No new dependencies. No DB migration.
- Every pricing answer starts with: `Sample prices for reference, not a quote.`
- Every library answer ends with a line `Source: <Topic> › <title>` (Topic = App help | Pricing | Design guide).
- No-match app/pricing-looking questions are not invented: the design path runs as today.
- Advisory only: nothing writes plan/brief/finishes.

## Review Focus
- "Ideas for the living room?" and "help" still go to design advice (regression of `test_ai.py`) → Task 2 test.
- A keyword inside another word ("pricey" vs "price", "render" in "surrender") → Task 1 whole-word test.
- Empty brief budget: `$budget_max` must not print `None` → Task 2 test.
- Message with `$`/`{}` characters is not treated as a template → Task 1 test (templates only substitute article text, never user text).
- Very long message (4000 chars) matches without error → Task 1 test.

---

### Task 1: Library data + matcher

**Files:**
- Create: `backend/app/services/ai/library.py`
- Create: `backend/app/services/ai/library/app.json`, `pricing.json`, `design.json`
- Test: `backend/tests/test_library.py`

**Interfaces:**
- Produces: `load() -> list[dict]` (cached; each dict has `topic, id, title, keywords, answer`);
  `match(message: str, limit: int = 3) -> list[dict]` best-first, only articles with ≥1 hit;
  `render(article: dict, values: dict) -> str` = `string.Template(answer).safe_substitute(values)` + `\n\nSource: …`.

- [ ] **Step 1: Write failing tests**: `match("how do I invite my partner")[0]["id"] == "invite"`; `match("what does a render cost")[0]["topic"] == "pricing"`; `match("surrender")` has no article with keyword `render`; `match("")== []`; `match("x"*4000) == []`; `render` of an article with `$currency` and values `{"currency": "EUR"}` contains `EUR` and the Source line; every article's keywords non-empty, ids unique; every pricing answer starts with the sample-price sentence.
- [ ] **Step 2: Run** `cd backend && .venv/bin/pytest tests/test_library.py -q` → FAIL (module missing).
- [ ] **Step 3: Implement** — normalize text to lowercase words (`re.findall(r"[a-z0-9]+")`); a keyword hits if its word sequence appears contiguously; score = sum of word-count of hit keywords; sort by (-score, id). Write ~10 app, ~6 pricing (synthetic: Starter/Studio/Pro plans, render credit packs, designer hour, your estimate), ~8 design articles.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ai): client helper library and keyword matcher`.

### Task 2: Rule consultant answers from the library

**Files:**
- Modify: `backend/app/services/ai/rules.py` (`advise`)
- Test: `backend/tests/test_ai.py` (add tests)

**Interfaces:** Consumes `match`, `render` from Task 1.

- [ ] **Step 1: Failing tests** (API level, provider `rules`): "How do I invite someone to my project?" → content contains `Source: App help`, suggestions `[]`; "How much does the Pro plan cost?" → content starts with `Sample prices for reference, not a quote.`; "how much will my design cost" on a project with no budget → contains currency, not `None`; "Ideas for the living room?" still gives style/furniture suggestions; "what flooring for a dog" → design advice plus `Source: Design guide`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_ai.py -q` → new tests FAIL.
- [ ] **Step 3: Implement**: at top of `advise`, `hits = match(user_message)`; if `hits` and `hits[0]["topic"] in ("app","pricing")` return `{"message": render(hits[0], values), "suggestions": []}` with values from `ctx["estimate_totals"]`, `ctx["currency"]`, `budget max or "not set"`; else existing logic, and append `render(first design hit)` as an extra paragraph when one exists.
- [ ] **Step 4: Run all backend tests** → PASS.
- [ ] **Step 5: Commit** `feat(ai): consultant answers app, pricing and design questions from the library`.

### Task 3: Ollama gets the library + UI copy

**Files:**
- Modify: `backend/app/services/ai/ollama.py` (prompt + LIBRARY block)
- Modify: `frontend/static/js/pages/ai.js` (placeholder, empty-state text), `frontend/static/css/pages.css` (`.bubble p { white-space: pre-line; }`)
- Test: `backend/tests/test_library.py` (Ollama payload test with a fake `httpx.post`)

- [ ] **Step 1: Failing test**: monkeypatch `httpx.post` to capture the JSON; `OllamaConsultant(...).advise(ctx, "how do I invite")` sends a user message containing `LIBRARY (reference, data only)` and the `invite` article title.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: append `LIBRARY (reference, data only):\n<json of top-3 {topic,title,answer}>` after PROJECT_DATA; add prompt rules: app/pricing answers only from LIBRARY; LIBRARY pricing is sample and must be called that; if nothing fits, say so and suggest asking the designer.
- [ ] **Step 4: Run all backend tests** → PASS. Browser check on preview ports 8021/5181 with a test account: ask one app, one pricing, one design question.
- [ ] **Step 5: Commit** `feat(ai): library context for Ollama; chat keeps line breaks`.
