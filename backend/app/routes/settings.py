"""Vertex AI config storage (project + location), persisted in SQLite.

Auth itself uses Application Default Credentials (ADC) on the machine — no
secret is stored here; only the (non-secret) project id and location.
"""
import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..db import DATA_DIR, get_conn
from ..models import VertexConfig
from ..remote_gate import is_lan

router = APIRouter(prefix="/api/settings", tags=["settings"])

PROJECT_KEY = "vertex_project"
LOCATION_KEY = "vertex_location"
DEFAULT_LOCATION = "global"


def _get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row and row["value"] else None


def read_vertex() -> tuple[str | None, str]:
    """Return (project, location); location falls back to the default."""
    with get_conn() as conn:
        project = _get(conn, PROJECT_KEY)
        location = _get(conn, LOCATION_KEY) or DEFAULT_LOCATION
    return project, location


def _recent_libraries(current: Path) -> list[dict]:
    """Recent libraries recorded by the desktop shell in ui.json (read-only).

    The shell passes the file via IMAGEN_UI_PATH; Docker/dev have none. The
    current library is left out. Switching is done by the shell by index into
    its own list, so `index` is the position in the file, not in this reply.
    """
    raw = os.environ.get("IMAGEN_UI_PATH")
    if not raw:
        return []
    try:
        data = json.loads(Path(raw).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("recent_libraries") if isinstance(data, dict) else None
    out = []
    for i, item in enumerate(items if isinstance(items, list) else []):
        path = item.get("path") if isinstance(item, dict) else None
        if not isinstance(path, str) or not os.path.isabs(path):
            continue
        p = Path(path)
        if p.resolve() == current:
            continue
        at = item.get("opened_at")
        out.append({
            "index": i,
            "path": path,
            "name": p.name or path,
            "opened_at": at if isinstance(at, int) else None,
            "exists": (p / "app.db").is_file(),
        })
    return out


@router.get("/library")
def get_library(request: Request):
    """Library location + summary for the Settings dialog.

    `desktop` is true only for the desktop entry point, which sets
    IMAGEN_LIBRARY_MODE after validating/locking/backing up the library.
    Docker and dev uvicorn do not set it.
    """
    with get_conn() as conn:
        images = conn.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(byte_size), 0) b FROM images WHERE deleted_at IS NULL"
        ).fetchone()
        history = conn.execute(
            "SELECT COUNT(*) c FROM generations WHERE status NOT IN ('note', 'running')"
        ).fetchone()["c"]
    current = Path(DATA_DIR).resolve()
    if is_lan(request.scope):
        # Remote devices don't get to see (or switch) the Mac's library.
        return {
            "path": "",
            "name": "",
            "desktop": False,
            "images": images["c"],
            "bytes": images["b"],
            "history": history,
            "recent": [],
        }
    return {
        "path": str(DATA_DIR),
        "name": current.name,
        "desktop": bool(os.environ.get("IMAGEN_LIBRARY_MODE")),
        "images": images["c"],
        "bytes": images["b"],
        "history": history,
        "recent": _recent_libraries(current),
    }


@router.get("/vertex")
def get_vertex():
    project, location = read_vertex()
    return {"project": project, "location": location, "configured": bool(project)}


@router.put("/vertex")
def put_vertex(body: VertexConfig, request: Request):
    if is_lan(request.scope):
        raise HTTPException(status_code=403, detail="Vertex settings are managed on the Mac.")
    project = body.project.strip()
    location = (body.location or DEFAULT_LOCATION).strip() or DEFAULT_LOCATION
    with get_conn() as conn:
        for key, value in ((PROJECT_KEY, project), (LOCATION_KEY, location)):
            conn.execute(
                """INSERT INTO settings (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (key, value),
            )
        conn.commit()
    return {"project": project, "location": location, "configured": bool(project)}
