# Client helper: how it works and how to edit it

The AI consultant tab (step 3, **AI visualizer** → AI consultant) answers clients' questions about **the app**,
**pricing** and **design**. It needs no AI model: answers come from a written library, matched by keywords, so they
are instant and free. Where Ollama is configured, the matched articles are also sent to the model as reference.

## How a question is answered

1. The question is matched against every article's keywords (whole words and phrases; longer phrases count more).
2. Best match is an **App help** or **Pricing** article → the helper answers with that article.
3. Otherwise → the usual design advice (brief, budget, catalog suggestions), plus the best **Design guide**
   article if one matched.
4. Every library answer ends with `Source: <topic> › <title>`.
5. The helper never changes the plan or any project data.

## Where the articles live

```
backend/app/services/ai/library/
  app.json      how to use SuperDes
  pricing.json  prices (SAMPLE DATA, see below)
  design.json   general design guidance
```

Each article:

```json
{"id": "invite", "title": "Inviting someone to a project",
 "keywords": ["invite", "invite link", "share my project"],
 "answer": "Text shown to the client."}
```

- `id`: unique, lowercase, no spaces.
- `keywords`: words or short phrases a client would type. Prefer phrases ("add a window") over single room words
  ("window"), which also appear in design questions and would steal them.
- `answer`: plain text; line breaks with `\n`. Pricing answers may use `$estimate_range`, `$currency`, `$budget_max`.

After editing, run the tests: `cd backend && .venv/bin/pytest tests/test_library.py tests/test_ai.py -q`.
They check that ids are unique, every article has keywords, and every pricing answer starts with the sample-price line.

## The prices are sample data

`pricing.json` holds **made-up prices** (plans 0 / 49 / 129 EUR per month, credit packs, designer rates) so the helper
has something to show. Every pricing answer starts with **"Sample prices for reference, not a quote."**
Before real clients rely on them: replace the numbers with your real prices, then remove that first line from each
pricing answer and from the check in `tests/test_library.py::test_library_shape`.

## Checking a wording

```sh
cd backend
.venv/bin/python -c "from app.services.ai.library import match; print([a['id'] for a in match('is the app free')])"
```

An empty list means no article matched: add that phrasing to the right article's keywords.
