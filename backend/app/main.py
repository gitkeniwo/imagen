"""FastAPI application: wires routes and serves the built frontend."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db import init_storage
from .routes import generate, generations, images, settings, tags

app = FastAPI(title="Nano Banana Studio")

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
app.include_router(tags.router)

# Serve the production build of the frontend if present.
DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # Fall back to index.html for client-side routing (non-/api paths).
        candidate = DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
