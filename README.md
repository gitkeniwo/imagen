# Imagen

A lightweight, single-user **image-to-image** web app powered by Google Vertex AI (Nano Banana models).

- Upload reference images, edit prompts, choose model / aspect ratio / resolution
- **ADC** authentication — no API keys stored; only Project ID + Location in local SQLite
- **Image library** with dedup (sha256) and lineage tracking
- **Generation history** — one-click reuse of prompts + reference images
- **Queue** with delayed send, cancellation, configurable concurrency, live status
- English / Chinese UI (localStorage)

<img width="1389" height="844" alt="Screenshot 2026-06-21 at 22 23 48" src="https://github.com/user-attachments/assets/e23dfa9d-5a02-4e50-b59a-d201d9329034" />


## Prerequisites

The app authenticates to Vertex AI via **ADC (Application Default Credentials)** — no API keys needed.

```bash
gcloud config set project <your-project>
gcloud services enable aiplatform.googleapis.com
gcloud auth application-default login
gcloud auth application-default set-quota-project <your-project>
```

The account needs the `Vertex AI User` role. After starting the app, open **Settings** and fill in your Project ID and Location.

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

Via GHCR (pre-built image):

```bash
mkdir -p ./imagen-data && docker run -d \
  --name imagen \
  -p 8000:8000 \
  -e IMAGEN_DATA_DIR=/data \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/adc.json \
  -v ./imagen-data:/data \
  -v ~/.config/gcloud/application_default_credentials.json:/gcloud/adc.json:ro \
  ghcr.io/gitkeniwo/imagen:latest
```

Or build locally with compose:

```bash
docker compose up --build -d     # → http://localhost:8000
```

## Verification

```bash
cd backend
PROJECT=<your-project> uv run python scripts/probe_gemini.py
```

## Data & Privacy

- All data lives in the mounted volume (`./imagen-data` with the command above, or `./backend/data` with compose).
- ADC credentials (`~/.config/gcloud/application_default_credentials.json`) are mounted read-only.
- Single-user, no access control — add your own if exposing to a network.
