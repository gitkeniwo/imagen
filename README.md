# Nano Banana Studio

A lightweight, single-user **image-to-image** web app powered by Google Vertex AI (Nano Banana models).

- Upload reference images, edit prompts, choose model / aspect ratio / resolution
- **ADC** authentication — no API keys stored; only Project ID + Location in local SQLite
- **Image library** with dedup (sha256) and lineage tracking
- **Generation history** — one-click reuse of prompts + reference images
- **Queue** with delayed send, cancellation, configurable concurrency, live status
- English / Chinese UI (localStorage)

## Tech Stack

- **Frontend:** React + Vite (TypeScript), no-dependency i18n
- **Backend:** Python + FastAPI, [`google-genai`](https://pypi.org/project/google-genai/) SDK via Vertex AI
- **Storage:** local filesystem (sha256 dedup + WebP thumbs), metadata in SQLite

## Quick Start

```bash
cd backend && uv sync                                    # Python deps
cd ../frontend && npm install                            # JS deps

# Dev (two terminals):
cd backend && uv run uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev                               # → http://localhost:5173

# Production:
cd frontend && npm run build
cd backend && uv run uvicorn app.main:app --port 8000    # → http://localhost:8000
```

## Docker

```bash
docker compose up --build -d     # → http://localhost:8000
```

Data is persisted via `./backend/data:/data`; ADC credentials are mounted read-only from the host.

## First-Time Setup (ADC)

```bash
gcloud config set project <your-project>
gcloud services enable aiplatform.googleapis.com
gcloud auth application-default login
gcloud auth application-default set-quota-project <your-project>
```

The account needs the `Vertex AI User` role. Then open the app, go to **Settings**, fill in your Project ID and Location.

## Verification

```bash
cd backend
PROJECT=<your-project> uv run python scripts/probe_gemini.py
```

## Data & Privacy

- All data lives in `backend/data/` (gitignored, never committed).
- No API keys stored; auth uses host machine ADC (`~/.config/gcloud/application_default_credentials.json`).
- Single-user, no access control — add your own if exposing to a network.
