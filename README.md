<div align="center">

# SuperDes

**An AI-assisted interior design studio for designers and their clients.**
Sketch a floor plan, explore styles with an AI consultant, request concept renders, estimate the budget and hand over a branded design dossier.

![Python 3.14](https://img.shields.io/badge/python-3.14-2F3E46?style=flat-square&labelColor=F4F1EA)
![FastAPI](https://img.shields.io/badge/backend-FastAPI-2F3E46?style=flat-square&labelColor=F4F1EA)
![Postgres RLS](https://img.shields.io/badge/data-Postgres%20%2B%20RLS-2F3E46?style=flat-square&labelColor=F4F1EA)
![Vanilla JS](https://img.shields.io/badge/frontend-vanilla%20JS%20%2B%20SVG-2F3E46?style=flat-square&labelColor=F4F1EA)
![Tests](https://img.shields.io/badge/tests-54%20passing-4F7A5A?style=flat-square&labelColor=F4F1EA)

![SuperDes demo: new project from the room wizard, place a sofa, save v2, ask the AI consultant, request a render, see the budget](docs/demo/superdes-demo.gif)

<sub>New project from the room wizard → place a sofa and save version 2 → ask the AI consultant → request a Japandi concept render → non-binding budget. Recorded from the running app · <a href="docs/demo/superdes-demo.mp4">MP4</a></sub>

</div>

## What it does

| Who | Can |
|---|---|
| **Designer / studio owner** | Create a branded studio, run projects, invite clients, edit plans, review changes, leave comments and tasks, publish a dossier |
| **Client** | Join through an invite or the studio's public link, draw their home, fill in a design brief, chat with the AI, request renders, follow the budget |
| **Guest** | Try the wizard and editor with nothing sent to a server. An account is needed only to save |

- **Room wizard and 2D editor.** Enter rooms and sizes, get an editable plan with walls, doors and windows. Drag walls (rooms and areas follow), place generic furniture and kitchen or bathroom fixtures, snap to a 100 mm grid, undo and redo.
- **Versioned plans.** Every save is an immutable version. Older versions stay viewable, comparable side by side and restorable.
- **Professional-review flags.** Moving walls or openings, or changing a kitchen or bathroom, marks the version *provisional — needs professional review*. Nothing in the app is ever presented as approval to build.
- **Design brief.** Styles, colours, materials, budget, household and lifestyle, needs, constraints, inspiration and existing furniture to keep.
- **AI consultant.** Brief-aware and plan-aware advice with suggestion cards (style, furniture, materials, alternative concepts). It **never edits the plan**; you accept or reject suggestions, and that feeds later advice.
- **Concept renders.** Pick a plan version, room, view angle and style. Each render is pinned to the version it came from, and every render costs one credit, refunded if it fails.
- **Budget and shopping list.** Generated from the plan's furniture and finishes, editable, always labelled *non-binding, not retailer prices*.
- **Collaboration.** Comments anchored to plan elements, concept decisions, tasks and messages between designer and client.
- **Dossier.** A printable, branded snapshot of plan, brief, concepts, renders, estimate and review status (save as PDF from the browser).
- **White label.** Studio name, logo, colours, font and template, shown to that studio's clients and in its dossiers.

## Screens

| Room plan editor | Concept renders |
|---|---|
| <img src="docs/screens/plan-editor.jpg" width="440" alt="2D plan editor with versions"> | <img src="docs/screens/renders.jpg" width="440" alt="Concept renders pinned to plan versions"> |
| **AI consultant** | **Version compare** |
| <img src="docs/screens/ai-consultant.jpg" width="440" alt="AI consultant suggestion cards"> | <img src="docs/screens/compare.jpg" width="440" alt="Side-by-side plan versions with the change highlighted"> |
| **Design brief** | **Budget (non-binding)** |
| <img src="docs/screens/brief.jpg" width="440" alt="Design brief form"> | <img src="docs/screens/budget.jpg" width="440" alt="Estimate with low/high ranges"> |
| **Studio dashboard** | **Branded dossier** |
| <img src="docs/screens/dashboard.jpg" width="440" alt="Studio dashboard with credits and client link"> | <img src="docs/screens/dossier.jpg" width="440" alt="Printable design dossier"> |

<img src="docs/screens/concept-render.png" width="520" alt="A concept render: Japandi living room drawn from plan version 2">

<sub>A concept render straight from the built-in renderer: the room, finishes and furniture come from the saved plan version, not from a free-form image model.</sub>

## How it works

```
frontend/  (static HTML/CSS + vanilla ES modules, SVG editor)
   │  fetch, cookie session, CSRF by Origin check
   ▼
backend/   (FastAPI)
   ├─ auth: argon2 passwords, short-lived JWT in an httpOnly cookie
   ├─ every request = one Postgres transaction with app.user_id / app.studio_id set
   ├─ services: geometry validation · review flags · estimates · credits · dossier
   ├─ AI consultant: Ollama (self-hosted or Ollama Cloud) → falls back to a rule-based consultant
   └─ render worker: Postgres queue (SKIP LOCKED) → ComfyUI if configured, else the built-in concept renderer
   ▼
Postgres / Supabase  (row-level security on every tenant table; the app role cannot bypass it)
```

- **Tenant isolation** is enforced twice: in the API and by Postgres row-level security. Tests prove one studio can't read another's plans, renders, messages, dossiers, estimates or uploads, through the API or with direct SQL.
- **The saved plan is the source of truth.** Renders and estimates always reference a plan version; nothing is inferred from a generated image.
- **No paid AI is required.** Without any AI service the app still works with its rule-based consultant and concept renderer.

## Run it

### Personal preview (just you, on this Mac)

```sh
./preview.sh
```

Open http://localhost:5180 and create your studio. Only the first account can register, and client links, invitations and the guest trial are switched off (`PREVIEW_MODE=1`). It uses its own database, `superdes_preview`, and listens on 127.0.0.1 only. Ctrl+C stops it.

Needs Postgres running locally (Postgres.app works).

### Development (full clientele)

```sh
# backend → http://localhost:8010
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
DATABASE_ADMIN_URL=postgresql:///superdes_dev APP_USER_PASSWORD=app_user_dev .venv/bin/python scripts/migrate.py
DATABASE_URL=postgresql://app_user:app_user_dev@localhost:5432/superdes_dev COOKIE_SECURE=0 \
  FRONTEND_ORIGIN=http://localhost:5173 JWT_SECRET=<32+ random chars> .venv/bin/uvicorn app.main:app --port 8010

# frontend → http://localhost:5173
cd frontend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
API_URL=http://localhost:8010 .venv/bin/python server.py
```

Optional AI settings go in `backend/.env` (git-ignored, see `backend/.env.example`): `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY` for Ollama Cloud, and `COMFYUI_URL` for real image generation.

### Tests

```sh
cd backend && .venv/bin/python -m pytest      # 54 tests: auth, geometry, versions, renders, credits, cross-tenant isolation, preview mode
cd frontend && ./smoke.sh                     # 55 API checks against a running backend
```

## Deployment

Each environment is **one service**: the API also serves the frontend (`SERVE_FRONTEND=1`), so the page and the API share an origin and the session cookie stays first-party (Safari blocks it across separate `*.onrender.com` / `*.up.railway.app` hosts).

| Environment | Host | Git branch | Database |
|---|---|---|---|
| `production` | Render (free) | `main` | Supabase (`app_user` through the session pooler) + Supabase Storage |
| `dev` | Railway | `dev` | Railway Postgres |

Build: `pip install -r requirements.txt` (repo root). Start: the `startCommand` in [`railway.toml`](railway.toml); health check `/health`.
Set `ENV`, `SERVE_FRONTEND=1`, `DATABASE_URL`, `JWT_SECRET`, and `API_URL` = `FRONTEND_ORIGIN` = the service's public URL. Production refuses to start without `JWT_SECRET`, `DATABASE_URL` and `FRONTEND_ORIGIN`. Migrations run from a trusted machine with `scripts/migrate.py`; the running service never holds the admin login. The full API contract is in [`backend/API.md`](backend/API.md).

## Status

Working MVP slice. Not yet done:

- **Hosting:** Railway and Supabase cloud hosting.
- **Photoreal renders:** these need a GPU running ComfyUI.
- **Chat that edits the plan:** planned, always with explicit confirmation.
- **In-app payments:** subscriptions and credits are tracked, but checkout isn't built.
- **Not planned:** 3D/360 views, CAD/PDF import and custom domains are outside this release.

> **Conceptual design only.** Plans, renders and estimates are not construction documents. Structural, plumbing, electrical and building-code matters need a qualified professional.
