# CLAUDE.md

Guidance for Claude Code working in this repo. Read this first.

## ⚠️ Critical rules (read before running anything)

- **NEVER delete or overwrite `backend/data/`.** It holds the user's *real* data:
  the SQLite DB (`app.db`), the image library, generation history, and the saved
  Vertex project/location. `rm -rf data`, wiping the DB, or `PUT /api/settings/vertex`
  with a test value all destroy real state.
- **For any local testing/verification, use an isolated DB** via the env override:
  `IMAGEN_DATA_DIR=/tmp/imagen-verify` (see `backend/app/db.py`). Never point a test
  at the real `backend/data/`.
- **Don't run generations against the real Vertex project for testing** — it spends
  the user's free credits. Use a bogus project on an isolated instance to exercise
  error paths instead.
- Don't blindly `kill` whatever is on port 8000; it may be the user's running app.

## Overview

Imagen — a lightweight, single-user **image-to-image** web app. It calls
Google's "Nano Banana" image models through **Vertex AI** using the official
`google-genai` SDK with **ADC** auth (no API keys; org policy disallows them).

- Models: `gemini-3-pro-image-preview` (Nano Banana Pro, **default**) and
  `gemini-2.5-flash-image` (Nano Banana).
- Frontend: React + Vite + TypeScript. Backend: Python + FastAPI.
- Storage: image files on local disk; metadata + Vertex config in SQLite.

## Repo layout

```
backend/
  app/
    main.py        FastAPI app; CORS; mounts routes; serves built frontend (frontend/dist)
    db.py          SQLite connection + schema; DATA_DIR (honors IMAGEN_DATA_DIR)
    storage.py     file persistence: sha256 dedup + Pillow WebP thumbnails
    gemini.py      Vertex call: request build, parse, normalize, + retry/backoff layer
    models.py      pydantic request models (GenerateRequest, VertexConfig)
    routes/        images.py, generate.py, generations.py, settings.py
  scripts/probe_gemini.py   one-off ADC connectivity probe
  pyproject.toml   deps managed by uv (uv.lock)
frontend/
  src/
    App.tsx        two-pane workspace + in-memory generation queue (processor lives here)
    api.ts         fetch wrapper + shared types + MODELS/ASPECT_RATIOS/RESOLUTIONS/OUTPUT_FORMATS
    i18n.tsx       tiny no-dependency i18n (zh/en dictionaries)
    components/    OptionBar, QueueList, ReferenceTray, SettingsModal
    pages/         Generate, Library, History
```

## Dev commands

Backend (uv):
```bash
cd backend
uv sync                                          # install/sync deps
uv run uvicorn app.main:app --reload --port 8000 # dev server
```

Frontend (Vite):
```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, proxies /api -> :8000
npm run build    # tsc -b && vite build; zero type errors == pass
```

Single-process / production: `npm run build`, then run only the backend — FastAPI
serves `frontend/dist` at `http://localhost:8000`.

Probe Vertex connectivity (after ADC is set up):
```bash
cd backend && PROJECT=<project-id> uv run python scripts/probe_gemini.py [image.png]
```

Isolated test instance (does NOT touch real data):
```bash
cd backend && IMAGEN_DATA_DIR=/tmp/imagen-verify uv run uvicorn app.main:app --port 8000
```

## Auth (ADC — no secrets)

The app stores **no key**. Settings only persist `vertex_project` and
`vertex_location` (non-secret) in the SQLite `settings` table. Credentials come from
the machine's Application Default Credentials. One-time host setup:

```bash
gcloud services enable aiplatform.googleapis.com
gcloud auth application-default login
gcloud auth application-default set-quota-project <project-id>
```

Client is built as `genai.Client(vertexai=True, project=..., location=...)`. ADC is
global (one credential file); the account needs the `Vertex AI User` role.

## Data & storage

- `backend/data/` = `app.db` + `images/<sha256>.<ext>` + `thumbs/<sha256>.webp`.
- Files are **deduped by sha256** (`storage.store_image`); thumbnails are WebP.
- Uploaded and generated images share the `images` table; `source` distinguishes them
  (`upload` | `generated`). Generated images auto-enter the library.
- **Lineage**: `generation_inputs` (ordered many-to-many inputs) + `generations.output_image_id`
  (the result). Deleting an image referenced by any generation is refused.

## Generate flow & contract

`POST /api/generate` returns **HTTP 200** with the business status in the body:
`success | blocked | error`. Only "no project configured" / input validation use 4xx.
A `generations` row is written for **every** outcome (including blocked/error), so
history records what was censored. `outputFormat` defaults to `image/jpeg`.

**Backend auto-retries** (in `gemini.py`) — callers/frontend must NOT add their own:
- Process-wide pacing gate (`_retry_gate_lock`, `MIN_VERTEX_ATTEMPT_SPACING = 4.0s`).
- Exponential backoff + jitter (`_retry_delay`).
- 429 → up to `MAX_ATTEMPTS = 30`; other retryable codes (500/502/503/504) → up to
  `MAX_NON_429_ATTEMPTS = 6`; 401/403/404 return immediately.
- Implication: a single generate call can block a while (~180s max backoff). Slowness
  is expected, not a bug.

Safety: all *configurable* harm categories are set to `OFF` (`_SAFETY_CATEGORIES`,
text + image side) to minimize censorship; Vertex still applies a non-configurable
baseline image filter, so `IMAGE_SAFETY` can still occur and is surfaced as `blocked`.

## Frontend queue & layout

- Layout is a **resizable two-pane workspace** (`App.tsx`): left sidebar = Library/History
  in `compact` mode (width persisted in `localStorage: imagen-sidebar-width`, drag the
  handle / double-click to reset); right main panel = Generate composer + queue. There
  are no top tabs.
- The generation **queue is client-side and in-memory**, owned by `App` (survives
  panel switches; **a page refresh loses not-yet-run tasks** — completed generations are
  already persisted server-side in history/library).
- Processor runs up to `MAX_CONCURRENT_GENERATIONS = 10` in parallel (bounded FIFO).
- Submitting snapshots the composer into the queue and **keeps the prompt** (intentional,
  for quick edits/re-runs). Each card shows a shimmer while pending/running, then result
  / status / error, with remove.
- Completing a task bumps `completedRefreshKey`, which refreshes Library/History via their
  `refreshKey` prop.

## Conventions

- **i18n**: `frontend/src/i18n.tsx` has `zh`/`en` dictionaries. The `reason_*` keys must
  stay in sync with `gemini.py`'s `BLOCK_FINISH` / `_HUMAN_BLOCK` / HTTP codes — the
  frontend localizes by `raw_finish`, falling back to the backend message.
- **Options**: model defaults to Pro; resolution (1K/2K/4K) applies only to Pro and is
  disabled otherwise; aspect ratio is a row of proportionally-shaped buttons; output
  format defaults to JPG.
- Keep changes lightweight and self-contained — this is a single-user local app with no
  auth; don't add multi-user/server infrastructure unless asked.
