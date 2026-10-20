"""Vertex AI config storage (project + location), persisted in SQLite.

Auth itself uses Application Default Credentials (ADC) on the machine — no
secret is stored here; only the (non-secret) project id and location.
"""
import os

from fastapi import APIRouter

from ..db import DATA_DIR, get_conn
from ..models import VertexConfig

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


@router.get("/library")
def get_library():
    """Read-only library location for the Settings dialog.

    `desktop` is true only for the desktop entry point, which sets
    IMAGEN_LIBRARY_MODE after validating/locking/backing up the library.
    Docker and dev uvicorn do not set it.
    """
    return {
        "path": str(DATA_DIR),
        "desktop": bool(os.environ.get("IMAGEN_LIBRARY_MODE")),
    }


@router.get("/vertex")
def get_vertex():
    project, location = read_vertex()
    return {"project": project, "location": location, "configured": bool(project)}


@router.put("/vertex")
def put_vertex(body: VertexConfig):
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
