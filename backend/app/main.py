"""FastAPI application: wires routes and serves the built frontend."""
import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import remote
from .db import init_storage
from .remote_gate import RemoteGate, is_lan
from .routes import drafts, generate, generations, images, settings, stats, tags
from .routes import desktop as desktop_routes
from .routes import remote as remote_routes

remote.check_server_code()

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


# Outermost: Host + cross-site checks everywhere; LAN trust rules on desktop.
app.add_middleware(RemoteGate)


@app.on_event("startup")
def _startup() -> None:
    init_storage()


if remote.is_desktop():
    @app.on_event("startup")
    async def _remote_startup() -> None:
        await remote.startup(app)

    @app.on_event("shutdown")
    async def _remote_shutdown() -> None:
        await remote.shutdown()


@app.get("/api/health")
def health(request: Request):
    # `token` lets the desktop shell verify it is talking to *its* backend on
    # the shared, fixed port. Docker runs without the env var, so it stays None.
    # LAN clients never see it.
    return {
        "ok": True,
        "app": "imagen",
        "token": None if is_lan(request.scope) else os.environ.get("IMAGEN_INSTANCE_TOKEN"),
    }


app.include_router(settings.router)
app.include_router(images.router)
app.include_router(generate.router)
app.include_router(generations.router)
app.include_router(stats.router)
app.include_router(tags.router)
app.include_router(drafts.router)
if remote.is_desktop():
    app.include_router(remote_routes.router)
    app.include_router(desktop_routes.router)
elif remote.is_server_auth():
    app.include_router(remote_routes.router)

# Serve the production build of the frontend if present.
def _resolve_dist() -> Path:
    """Locate the built frontend.

    Order: explicit override -> PyInstaller bundle -> repo-relative checkout.
    """
    override = os.environ.get("IMAGEN_FRONTEND_DIST")
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, "frozen", False):
        # onedir: resources land in `_internal/` (sys._MEIPASS).
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "frontend_dist"
    return Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


DIST = _resolve_dist()

# The webview (WKWebView inside the desktop shell, or a browser) heuristically
# caches `index.html` because FileResponse sends no Cache-Control header. That
# pins the whole SPA to a previously built bundle: asset filenames are hashed,
# but the HTML that points at them is reused, so a fresh install keeps showing
# the old UI until the cache entry expires. Never let HTML be stored.
NO_STORE = {"Cache-Control": "no-store, max-age=0"}

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html", headers=NO_STORE)

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
            return FileResponse(candidate, headers=NO_STORE)
        return FileResponse(DIST / "index.html", headers=NO_STORE)
