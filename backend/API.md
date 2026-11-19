# SuperDes API contract

Base URL: the backend origin (e.g. `http://localhost:8000`). All bodies are JSON (`Content-Type: application/json`) unless noted. Timestamps are ISO-8601 with timezone; ids are UUID strings; lengths are **millimetres**; money is a number in `currency` (default `EUR`).

## Conventions

### Session cookie
- `POST /auth/register`, `/auth/login`, `/public/studios/{slug}/join` and `/public/invitations/{token}/accept` set cookie `sd_session` (HS256 JWT, 1 h, `HttpOnly`, `Secure` unless `COOKIE_SECURE=0`, `SameSite=Lax` by default, `Path=/`). No refresh: on `401` send the user to login.
- Frontend must call with credentials: `fetch(url, {credentials: "include", ...})`.
- If frontend and API are on different *sites* (not just subdomains of one registrable domain), set `COOKIE_SAMESITE=none` (requires Secure) or the browser will not send the cookie.

### CORS and CSRF
- CORS is allowed only for origins listed in `FRONTEND_ORIGIN` (comma list), with `Access-Control-Allow-Credentials: true`. Allowed request header: `Content-Type`.
- Every `POST/PUT/PATCH/DELETE` must carry an `Origin` (or `Referer`) header matching `FRONTEND_ORIGIN`; browsers do this automatically. Otherwise `403 csrf_origin_rejected`. GET never changes state.

### Errors
All errors share one shape:
```json
{"error": {"code": "not_found", "message": "project not found", "details": null}}
```
| status | code(s) |
|---|---|
| 400 | `invalid_image` |
| 401 | `unauthenticated`, `invalid_credentials` |
| 402 | `insufficient_credits` |
| 403 | `forbidden`, `csrf_origin_rejected`, `preview_mode` (see Personal preview mode) |
| 404 | `not_found` (also returned for anything in another studio / an ungranted project — never 403) |
| 409 | `email_taken`, `slug_taken`, `already_in_studio`, `no_studio`, `version_conflict` (`details.current_version_no`) |
| 410 | `invitation_invalid` (expired, used or revoked) |
| 413 | `too_large` |
| 422 | `validation_error` — `details: [{"loc": ["body","geometry","walls",0,"a",0], "msg": "...", "type": "..."}]` |
| 429 | `rate_limited` (login: 10 attempts / 5 min per email and 50 / 5 min per IP; sign-up via `/auth/register` or `/public/studios/{slug}/join`: 20 / 10 min per IP; AI chat: 20 messages / min per user) · `render_quota_exceeded` (client render quota, see Renders) |
| 500 | `internal_error` |

### Roles
- **owner**: created the studio. Everything a designer can do + branding, audit, designer invitations.
- **designer** (staff): all projects of the studio.
- **client**: only projects granted to them (via invitation or the project they created through the public studio link).
- Auth column below: `public` (no cookie), `user` (logged in, may have no studio), `member` (any role in a studio; project routes additionally require access to that project), `staff` (owner/designer), `owner`.
- A logged-in user without a studio gets `409 no_studio` on member routes.

### Common objects
```
User      {id, email, display_name, created_at}
Me        {user: User, studio: {id, slug, name} | null, role: "owner"|"designer"|"client"|null}
Version   {id, version_no, author_id, author_role, label, review_status: "conceptual"|"provisional",
           review_flags: Flag[], reviewed_by, reviewed_at, created_at, geometry?, caveat?}
Flag      {category: "structural"|"wall"|"opening"|"kitchen"|"bathroom", element_id, change: "added"|"removed"|"changed",
           reason, carried_from?: version_no}
```
`caveat` (string) is the professional caveat: conceptual only, not approved for construction, needs a qualified professional. It is returned on plan, version, render and dossier responses — show it as a persistent banner.

### Geometry (canonical plan JSON)
Origin top-left, y down, units mm. All numbers finite, coordinates within ±100000. Unknown fields are rejected.
```json
{
  "walls":     [{"id": "w1", "a": [0, 0], "b": [5000, 0], "thickness": 100, "structural": false}],
  "openings":  [{"id": "o1", "wall_id": "w1", "offset": 500, "width": 900, "kind": "door"}],
  "rooms":     [{"id": "r1", "name": "Living", "kind": "living", "polygon": [[0,0],[5000,0],[5000,4000],[0,4000]]}],
  "fixtures":  [{"id": "x1", "kind": "toilet", "x": 100, "y": 100, "w": 380, "d": 650, "rot": 0}],
  "furniture": [{"id": "f1", "catalog_key": "sofa-3", "label": "", "x": 1000, "y": 2800, "w": 2100, "d": 900, "rot": 0}]
}
```
Rules: `id` 1–64 chars `[A-Za-z0-9_.:-]`, unique across the whole plan; wall length > 0; `thickness`/`w`/`d`/`width` > 0; opening `offset >= 0` and `offset + width <= wall length` (offset measured from `a`); room `polygon` 3–200 points with non-zero area; room `kind` ∈ living, bedroom, kitchen, bathroom, dining, office, hallway, other; fixture `kind` ∈ sink, toilet, shower, bathtub, stove, fridge, counter, dishwasher, other; `name`/`label` ≤ 100 chars; `catalog_key` ≤ 64; `rot` degrees −360..360 (about the item centre; `x,y` is the top-left before rotation). Max counts: walls 500, openings 500, rooms 100, fixtures 500, furniture 1000. All arrays optional (`{}` is a valid empty plan).

Review flags: a save is diffed against the previous version. Changes to walls (structural → `structural`), openings, wet-room (kitchen/bathroom) kind/polygon, and fixtures set `review_status: "provisional"`; furniture never flags. The first drawn layout (previous version has no walls) is the baseline and is not flagged. Unreviewed flags carry forward until staff mark the version reviewed (→ `conceptual`; there is no "approved for construction" state).

---

## Health
| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | public | `200 {"status":"ok","db":"ok"}` or `503 {"status":"degraded","db":"unreachable"}` |

### Personal preview mode (`PREVIEW_MODE=1`)
Single-owner mode for running the app alone. Off by default; with it off nothing below applies.
- `GET /health` adds `"preview_mode": true, "setup_open": bool` (`setup_open`: no account exists yet).
- `POST /auth/register` succeeds only while the database has no users (that first user then creates the studio with `POST /studios` and becomes owner); afterwards `403 preview_mode`.
- `403 preview_mode` always: `GET /public/studios/{slug}`, `POST /public/studios/{slug}/join`, `POST /invitations`, `GET /public/invitations/{token}`, `POST /public/invitations/{token}/accept`.
- Everything else (projects, plans, AI, renders, budget, dossier, branding, collaboration, logo) is unchanged.

## Auth
| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/auth/register` | public | `{email, password (8–128), display_name? (≤100)}` | `201 Me` + cookie |
| POST | `/auth/login` | public | `{email, password}` | `200 Me` + cookie; `401 invalid_credentials`; `429` |
| POST | `/auth/logout` | public | – | `200 {"ok":true}`, clears cookie |
| GET | `/auth/me` | user | – | `200 Me` |

## Studios, members, credits, audit
| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| POST | `/studios` | user (no studio yet) | `{name (1–100), slug (^[a-z0-9-]{3,40}$)}` | `201 Me` (role `owner`). Creates 14-day trial subscription + 50 render credits. `409 slug_taken` / `already_in_studio` |
| GET | `/studio` | member | – | `{studio: {id, slug, name, owner_id, created_at}, role, subscription: {plan_key, status, trial_ends_at}, credits: int\|null (null for clients)}` |
| GET | `/studio/members` | staff | – | `{members: [{id, email, display_name, role, created_at}]}` |
| GET | `/studio/credits` | staff | – | `{balance, ledger: [{id, delta, reason, render_job_id, created_by, created_at}]}` (reasons: `trial_grant`, `render`, `render_refund`) |
| GET | `/studio/audit` | owner | `?limit=1..500 (100)&before_id=` | `{events: [{id, actor_id, action, target_type, target_id, data, created_at}]}` newest first; page with `before_id` = last id |
| GET | `/plans` | public | – | `{plans: [{key, name, monthly_credits, price_note}]}` (no checkout) |

Audit actions include: `auth.register`, `auth.login`, `auth.logout`, `studio.create`, `project.create`, `project.update`, `plan.version_save`, `review.decision`, `render.request`, `render.succeeded`, `render.failed`, `credits.grant`, `credits.debit`, `credits.refund`, `invitation.create`, `invitation.accept`, `invitation.revoke`, `dossier.submit`, `branding.update`, `branding.logo`.

## Branding
Fonts allowlist: `inter, lora, playfair, source-sans, roboto, merriweather, system`. Templates: `classic, modern, minimal`. Colors `^#[0-9a-fA-F]{6}$`.
`Branding = {display_name, logo_upload_id, primary_color, accent_color, background_color, font, template, updated_at}`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/studio/branding` | member | – | `Branding` |
| PUT | `/studio/branding` | owner | any subset of `{display_name, primary_color, accent_color, background_color, font, template}` | `Branding` |
| POST | `/studio/branding/logo` | owner | multipart `file` (image ≤10 MB) | `Branding` |
| GET | `/studio/branding/logo` | member | – | image bytes |
| GET | `/public/studios/{slug}` | public | – | `{slug, name, display_name, primary_color, accent_color, background_color, font, template, logo_url: string\|null}` or 404 |
| GET | `/public/studios/{slug}/logo` | public | – | image bytes or 404 |

Apply branding as CSS variables only after it arrives from these endpoints (values are server-validated).

## Joining a studio
| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/public/studios/{slug}/join` | public | `{email, password, display_name?, project_name? (default "My project"), geometry?: Geometry}` | `201 Me & {project: Project}` + cookie. Creates a client account and a new project in that studio (use `geometry` to save a guest localStorage plan as version 1). |
| POST | `/invitations` | staff (designer role: owner only) | `{role: "client"\|"designer", project_id (required for client), email?, ttl_hours? 1–720 (168)}` | `201 {id, project_id, role, email, expires_at, created_at, token, accept_path: "/invitations/{token}"}` — `token` is shown only once; build the link for the designer to copy |
| GET | `/invitations` | staff | – | `{invitations: [{id, project_id, role, email, expires_at, used_at, created_at}]}` |
| DELETE | `/invitations/{id}` | staff | – | `{"ok":true}` (unused invitations only) |
| GET | `/public/invitations/{token}` | public | – | `{studio_name, studio_slug, role, project_name, expires_at, valid: bool}` or 404 |
| POST | `/public/invitations/{token}/accept` | public or user | logged in: `{}`; otherwise `{email, password, display_name?}` | `200 Me & {project_id}` + cookie. Single use. If the invitation has an `email`, the accepting account's email must match it (case-insensitive), else `403 invitation_email_mismatch` (invitation stays unused). `410 invitation_invalid`, `409 already_in_studio` (account belongs to another studio) |

Guest trial: the server stores nothing for guests. Keep the plan in `localStorage`; after register → `POST /studios` → `POST /projects {geometry}` (designer), or `POST /public/studios/{slug}/join {geometry}` (client).

## Projects
`Project = {id, studio_id, name, status: "active"|"archived", created_by, created_at}`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/projects` | member | – | `{projects: [{id, name, status, created_at, current_version_no, review_status}]}` (clients see only granted ones) |
| POST | `/projects` | staff | `{name, geometry?: Geometry}` | `201 Project` (version 1 = `geometry` or empty, label `initial`) |
| GET | `/projects/{id}` | member | – | `Project & {my_role, people: [{id, display_name, email, role}]}` |
| PATCH | `/projects/{id}` | staff | `{name?, status?}` | `Project` |

## Plans and versions (all under `/projects/{id}`; auth member unless noted)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/plan` | – | `{plan_id, current_version: Version (with geometry), caveat}` |
| GET | `/plan/versions` | – | `{versions: Version[] (no geometry, newest first), caveat}` |
| GET | `/plan/versions/{n}` | – | `Version` with geometry + caveat |
| POST | `/plan/versions` | `{geometry: Geometry, label? (≤200), base_version_no?}` | `201 Version` with geometry + caveat. With `base_version_no`, `409 version_conflict` if someone saved meanwhile. Versions are immutable. |
| GET | `/plan/compare?from=1&to=3` | – | `{from, to, diff: {walls|openings|rooms|fixtures|furniture: {added: id[], removed: id[], changed: id[]}}, flags: Flag[], caveat}` |
| POST | `/plan/versions/{n}/review` | staff; `{note? ≤2000}` | `Version` with `review_status: "conceptual"`, `reviewed_by/at` set; logs a `reviewed` decision |

## Brief
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/projects/{id}/brief` | – | `{brief: Brief, updated_at, updated_by}` |
| PUT | `/projects/{id}/brief` | `Brief` (full replace) | `{brief, updated_at, updated_by}` |

```
Brief {
  styles: string[≤10], colors: string[≤20], materials: string[≤20]        (each 1–60 chars)
  budget: {min?: number, max?: number, currency: "EUR" (3 uppercase), priority: "low_cost"|"balanced"|"premium"}
  functional_needs: string[≤30], lifestyle: string[≤20], constraints: string[≤30]   (each 1–300 chars)
  household: {adults 0–20 (1), children 0–20 (0), pets: string[≤10], works_from_home: bool, accessibility_needs: string ≤1000}
  inspiration_upload_ids: uuid[≤30] (must be this project's uploads), inspiration_urls: ("http(s)://...")[≤20]
  existing_items: [{name, keep: bool, width_mm?, depth_mm?, notes?}] ≤50
  notes: string ≤5000
}
```
All fields optional; omitted ones take the defaults shown.

## Catalog and finishes
| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/catalog/furniture?category=&room_kind=` | public | `{items: [{key, name, category, room_kinds[], styles[], width_mm, depth_mm, height_mm, price_low, price_high}], basis}` (categories: seating, tables, storage, beds, textiles, lighting, kitchen, bathroom) |
| GET | `/catalog/finishes?surface=floor\|wall` | public | `{finishes: [{key, name, surface, color, styles[], price_low_m2, price_high_m2}], basis}` |
| GET | `/catalog/styles` | public | `{styles: [{key, name, description, palette: {floor, wall, accent, furniture}, materials[]}]}` |
| GET | `/projects/{id}/finishes` | member | `{selections: [{id, room_id, surface, finish_key, name, color}]}` |
| PUT | `/projects/{id}/finishes` | member | body `{room_id, surface: "floor"\|"wall", finish_key}` (upsert per room+surface) → `{id, room_id, surface, finish_key}`; 422 if finish/surface mismatch |
| DELETE | `/projects/{id}/finishes/{selection_id}` | member | `{"ok":true}` |

## Uploads, moodboards, alternatives (under `/projects/{id}`, member)
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/uploads` | multipart `file`: PNG/JPEG/WEBP/GIF, ≤10 MB, verified server-side | `201 {id, project_id, kind, content_type, size_bytes, width, height, filename, created_at, url}` |
| GET | `/uploads` | – | `{uploads: [... & url]}` |
| GET | `/uploads/{upload_id}/content` | – | image bytes (cookie-authorized; use as `<img src>` on the same credentials) |
| GET / POST | `/moodboards` | POST `{name}` | list `{moodboards: [{id, name, created_by, created_at, ...}]}` / `201 moodboard` |
| GET | `/moodboards/{mid}` | – | `moodboard & {items: [{id, kind, ref, note, position, catalog_name?, finish_name?, finish_color?, image_url? (uploads)}]}` |
| DELETE | `/moodboards/{mid}` | – | `{"ok":true}` |
| POST | `/moodboards/{mid}/items` | `{kind: "catalog"\|"finish"\|"upload"\|"color"\|"note", ref (catalog key / finish key / upload id / #RRGGBB / ""), note? ≤1000, position? 0–10000}` | `201 item` |
| DELETE | `/moodboards/{mid}/items/{item_id}` | – | `{"ok":true}` |
| GET | `/alternatives` | – | `{alternatives: [{id, name, description, style_key, plan_version_id, plan_version_no, created_by, created_at}]}` |
| POST | `/alternatives` | `{name, description?, style_key?, plan_version_no? (default current)}` | `201 alternative & {plan_version_no}` |
| DELETE | `/alternatives/{aid}` | – | `{"ok":true}` |

## Estimates (under `/projects/{id}`, member)
```
Estimate {
  items: [{item_key, source: "auto"|"manual", category, label, qty, unit: "pcs"|"m2"|..., unit_low, unit_high,
           total_low, total_high, rooms: string[], note, overridden: bool, excluded: bool, id? (manual only)}],
  totals: {low, high}, currency, plan_version_no,
  basis: "generic estimate, not a retailer price", non_binding: true, label: "Estimate - non-binding", disclaimer
}
```
Auto items come from the current plan: furniture grouped by `catalog_key` (`furn:<key>`), and finish selections × room area (`finish:<room_id>:<surface>`; floor = polygon area, wall = perimeter × 2.6 m). Always display the non-binding label.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/estimates` | – | `Estimate` |
| PUT | `/estimates/overrides/{item_key}` | `{label?, qty?, unit_low?, unit_high?, excluded?: bool}` (null = keep auto value) | `Estimate` |
| DELETE | `/estimates/overrides/{item_key}` | – | `Estimate` |
| POST | `/estimates/items` | `{label, qty (1), unit ("pcs"), unit_low (0), unit_high (0)}` | `201 Estimate` |
| DELETE | `/estimates/items/{item_id}` | – | `Estimate` |
| GET | `/shopping-list` | – | `{items: [{item_key, label, category, qty, unit, unit_low, unit_high, total_low, total_high, rooms}], totals, currency, plan_version_no, retailer: null, basis, non_binding: true, label, disclaimer}` (excluded items omitted) |

## AI consultant (under `/projects/{id}`, member)
The AI only advises. It never edits the plan or any data; suggestions are never auto-applied.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/ai/messages` | `{message (1–4000), conversation_id?}` | `201 {conversation_id, user_message: Msg, message: Msg, note}` |
| GET | `/ai/conversations` | – | `{conversations: [{id, created_by, created_at, message_count}]}` |
| GET | `/ai/conversations/{cid}/messages` | – | `{messages: Msg[]}` oldest first |
| POST | `/ai/suggestions/{suggestion_id}/feedback` | `{decision: "accept"\|"reject"}` | `{suggestion_id, kind, key, decision, created_at}` — recorded as a preference; later advice avoids rejected and favours accepted items. Does not change the plan. |
| GET | `/ai/preferences` | – | `{preferences: [{suggestion_id, kind, key, decision, user_id, created_at}]}` |

```
Msg        {id, conversation_id, role: "user"|"assistant", content, suggestions: Suggestion[], provider: "rules"|"ollama"|null, author_id, created_at}
Suggestion {id, kind: "style"|"furniture"|"material"|"concept"|"budget"|"layout_note", key, title, detail, data: object, applied: false}
```
`data` examples: style/concept `{palette}`; furniture `{room_id, width_mm, depth_mm}` (a client may offer "place it" by creating a new plan version itself); material `{surface, color}`.

## Renders (under `/projects/{id}`, member)
Angles: `front, back, left, right, corner-ne, corner-nw, corner-se, corner-sw`.
```
RenderJob {id, project_id, plan_version_id, plan_version_no, view: {room_id, angle, style}, status: "queued"|"running"|"succeeded"|"failed",
           error, idempotency_key, result_url: string|null, created_at, started_at, finished_at,
           label: "Conceptual visualization", caveat, replayed?: bool}
```
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/renders` | `{view?: {room_id?, angle? ("front"), style? (style key)}, plan_version_no? (default current), idempotency_key? ([A-Za-z0-9_.:-], ≤100)}` | `202 RenderJob` (debits 1 credit) · `200 RenderJob & replayed:true` if the key was already used in this project (no new debit) · `402 insufficient_credits` · `422` unknown room/style · `429 render_quota_exceeded` when a **client** already has `RENDER_CLIENT_QUOTA` (default 5) non-failed renders in this project (staff: unlimited, subject to credits) |
| GET | `/renders` | – | `{renders: RenderJob[] newest first, caveat}` |
| GET | `/renders/{rid}` | – | `RenderJob` — poll every ~2 s until `succeeded`/`failed` |
| GET | `/renders/{rid}/image` | – | `image/png` |

Generate a fresh `idempotency_key` per user click (e.g. `crypto.randomUUID()`) and reuse it on retries. Failed jobs refund the credit automatically; `error` is a generic user-facing message (details are only logged server-side). Each job is pinned to the plan version it was requested for; older renders stay retrievable.

## Collaboration (under `/projects/{id}`, member unless noted)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/comments?plan_version_no=` | – | `{comments: [{id, body, element_id, author_id, author_name, plan_version_no, created_at}]}` |
| POST | `/comments` | `{body (1–5000), plan_version_no? (current), element_id? (must exist in that version)}` | `201 comment` |
| GET | `/decisions` | – | `{decisions: [{id, plan_version_no, decision, note, decided_by, decided_role, created_at}]}` |
| POST | `/decisions` | `{plan_version_no, decision: "concept_approved"\|"changes_requested", note?}` | `201 decision` (concept decision only, never construction approval) |
| GET | `/tasks` | – | `{tasks: [{id, title, assignee_id, status, created_by, created_at, updated_at}]}` |
| POST | `/tasks` | `{title (1–200), assignee_id? (must have project access), status? "todo"\|"doing"\|"done"}` | `201 task` |
| PATCH | `/tasks/{tid}` | any of `{title, assignee_id (null = unassign), status}` | `task` |
| DELETE | `/tasks/{tid}` | staff | `{"ok":true}` |
| GET | `/messages?after=<ISO timestamp>` | – | `{messages: [{id, author_id, author_name, body, created_at}]}` oldest first, max 500 (poll with `after` = last `created_at`) |
| POST | `/messages` | `{body (1–5000)}` | `201 {id, author_id, body, created_at}` |

## Dossiers (under `/projects/{id}`)
| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/dossiers` | staff | `{plan_version_no? (current), note? ≤2000}` | `201 {id, plan_version_no, review_status, note, created_by, created_at, html_url, caveat}` — stores an immutable HTML snapshot (branding, plan SVG, brief, concepts, latest render thumbnails, non-binding estimate, version/review metadata, caveat) |
| GET | `/dossiers` | member | – | `{dossiers: [... & html_url], caveat}` |
| GET | `/dossiers/{did}` | member | – | `text/html` print-friendly page with strict CSP (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`). Open in a new tab (cookie needed) or fetch the text and show it in a sandboxed `<iframe srcdoc>`; use the browser's print to save a PDF. |
