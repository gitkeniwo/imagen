"""FastAPI application: wires routes and serves the built frontend."""
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db import init_storage
from .routes import drafts, generate, generations, images, settings, stats, tags

app = FastAPI(title="Imagen")

# Suppress uvicorn access logs for noisy progress-poll requests.
class _ProgressAccessFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/generate/progress/" not in record.getMessage()

logging.getLogger("uvicorn.access").addFilter(_ProgressAccessFilter())

# Allow the Vite dev server (separate origin) during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_storage()


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(settings.router)
app.include_router(images.router)
app.include_router(generate.router)
app.include_router(generations.router)
app.include_router(stats.router)
app.include_router(tags.router)
app.include_router(drafts.router)

# Serve the production build of the frontend if present.
DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # Unmatched API routes must 404 as JSON, not fall back to index.html.
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Fall back to index.html for client-side routing (non-/api paths).
        # Resolve and require containment in DIST so `..` segments can't
        # escape the build directory.
        candidate = (DIST / full_path).resolve()
        if candidate.is_relative_to(DIST) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
