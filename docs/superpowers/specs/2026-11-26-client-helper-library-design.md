# Client helper library — design (2026-11-26)

## Intent
A real-time helper for SuperDes clients that answers **app questions, pricing and design** fast and correctly,
inside the existing project consultant. No Claude, no local model: it extends the consultant we already have
(rule-based consultant, plus Ollama Cloud where it is configured).

## Goals
- Answer app how-to and pricing questions from a written library, instantly and at no cost.
- Keep today's design advice (brief, budget, catalog suggestions) and add a matching design tip.
- Say "I don't know, ask your designer" instead of guessing.

## Non-goals
- New AI provider, embeddings, search index, streaming.
- Real prices: pricing is **synthetic sample data**, labelled as such, in one file to replace later.

## Anti-goals
- The helper changes the plan or any project data.
- A sample price read as a quote.
- Existing design advice regresses (e.g. "Ideas for the living room?" must still give design suggestions).

## Approaches
1. Whole library sent to an LLM each time (cached). Rejected: user ruled out Claude/local model.
2. Search, then send matching pieces to an LLM. Rejected: same reason, and can miss.
3. **Keyword library inside the existing consultant (chosen).** Instant and free; misses only when wording
   is outside the keywords, so each article lists several keywords and phrasings.

## Design
- Library: `backend/app/services/ai/library/{app,pricing,design}.json`, each a list of
  `{id, title, keywords[], answer}`. Answers may use `$estimate_low $estimate_high $currency $budget_max`.
- Matching: normalized whole-word/phrase keyword hits; best article wins; minimum one hit.
- Rule consultant: best match in `app`/`pricing` → answer from the article, plus "Source: <Topic> › <title>".
  Otherwise the current design advice, plus the best design tip if one matched.
- Ollama consultant: the top 3 matched articles go in a separate LIBRARY block (outside the truncated
  project data); prompt says app/pricing answers come only from LIBRARY and pricing is sample.
- Frontend: chat bubble keeps line breaks; placeholder mentions app and pricing questions.
- Unchanged: rate limit (20/min/user), advisory-only, conversation storage.

## Left to the builder
Article wording and keyword lists; exact scoring weights.
