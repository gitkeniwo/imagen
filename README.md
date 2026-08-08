# Imagen

A lightweight, single-user **image-to-image** web app powered by Google Vertex AI (Nano Banana models).

- Upload reference images, edit prompts, choose model / aspect ratio / resolution
- **ADC** authentication — no API keys stored; only Project ID + Location in local SQLite
- **Image library** with dedup (sha256) and lineage tracking
- **Generation history** — one-click reuse of prompts + reference images
- **Queue** with delayed send, cancellation, configurable concurrency, live status
- **Persistent drafts** with input/output attachments, pinning, inline prompt editing, and safe queue/copy/move actions
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

## Migrating to a New Machine

Three things make up this app, and two of them live **outside the repo**:

1. **The project itself** — copy the whole directory (or `git clone` it). Note that `docker-compose.yml` is gitignored: if you customized it (e.g. data paths), bring it along, or recreate from `docker-compose.example.yml`.

2. **Your data** — the SQLite database (`app.db`: generation history, drafts, and your saved Project ID/Location) plus the image library and thumbnails. They live in the data directory you mounted (e.g. `./imagen-data`, or `backend/data` with compose), never in git. Copy the entire directory to the same path on the new machine.

3. **ADC (Application Default Credentials)** — the credential file `~/.config/gcloud/application_default_credentials.json` is **machine-local**; it is not part of this repo and does not travel with it. On the new machine, re-run the one-time setup from [Prerequisites](#prerequisites):

   ```bash
   gcloud auth application-default login
   gcloud auth application-default set-quota-project <your-project-id>
   ```

   Use the same Google account that has the `Vertex AI User` role. Re-login is the reliable path — do not try to copy the credential file. Your Project ID/Location are already saved in the database from step 2, so no Settings change is needed.

Your saved data does **not** need modifying; only the machine-local credentials must be recreated.

### If the container doesn't pick up the new credentials

The container mounts the ADC file read-only at startup (`/gcloud/adc.json`). Normally the mount is live — editing the file doesn't require any action. If the app still reports *"No ADC credentials found"*, recreate the container so Docker re-establishes the mount:

```bash
docker compose up -d --force-recreate
```

This never touches your data directory.

## Verification

```bash
cd backend
PROJECT=<your-project> uv run python scripts/probe_gemini.py
```

## Data & Privacy

- All data lives in the mounted volume (`./imagen-data` with the command above, or `./backend/data` with compose).
- Drafts are stored in SQLite; deleting a draft never deletes its attached library images.
- ADC credentials (`~/.config/gcloud/application_default_credentials.json`) are mounted read-only.
- Single-user, no access control — add your own if exposing to a network.
