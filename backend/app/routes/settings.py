"""Vertex AI config storage (project + location), persisted in SQLite.

Auth itself uses Application Default Credentials (ADC) on the machine — no
secret is stored here; only the (non-secret) project id and location.
"""
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import remote
from ..db import DATA_DIR, get_conn, library_key
from ..models import VertexConfig
from ..provider_config import (
    DEFAULT_LOCATION, LOCATION_KEY, PROJECT_KEY, put_setting, read_vertex,
)
from ..remote_gate import require_admin, role

router = APIRouter(prefix="/api/settings", tags=["settings"])
logger = logging.getLogger("imagen.library")

LIBRARY_REQUEST_TTL_S = 30.0
MAX_RECENT_LIBRARIES = 8
_library_request_lock = threading.Lock()
_library_request: dict | None = None


class SwitchLibraryBody(BaseModel):
    index: int = Field(ge=0)
    id: str = Field(min_length=1, max_length=64)
    force: bool = False


def _recent_libraries(current: Path) -> list[dict]:
    """Recent libraries recorded by the desktop shell in ui.json (read-only).

    The shell passes the file via IMAGEN_UI_PATH; Docker/dev have none. The
    current library is left out. `index` uses the same numbering as the shell's
    filtered list: malformed entries do not consume an index, and the list is
    capped before the current library is removed.
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
    shell_index = 0
    for item in (items if isinstance(items, list) else []):
        path = item.get("path") if isinstance(item, dict) else None
        if not isinstance(path, str) or not os.path.isabs(path):
            continue
        if shell_index >= MAX_RECENT_LIBRARIES:
            break
        index = shell_index
        shell_index += 1
        p = Path(path)
        if p.resolve() == current:
            continue
        resolved = p.resolve()
        at = item.get("opened_at")
        out.append({
            "index": index,
            "path": path,
            "id": hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:16],
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
    key = library_key()
    current_role = role(request.scope)
    if current_role == "member":
        # Members never get to see (or switch) the Mac's library.
        return {
            "path": "",
            "name": "",
            "desktop": False,
            "images": images["c"],
            "bytes": images["b"],
            "history": history,
            "key": key,
            "recent": [],
        }
    if current_role == "admin":
        recent = [
            {
                key: value
                for key, value in item.items()
                if key != "path"
            }
            for item in _recent_libraries(current)
        ]
        return {
            "path": "",
            "name": current.name,
            "desktop": True,
            "images": images["c"],
            "bytes": images["b"],
            "history": history,
            "key": key,
            "recent": recent,
        }
    return {
        "path": str(DATA_DIR),
        "name": current.name,
        "desktop": bool(os.environ.get("IMAGEN_LIBRARY_MODE")),
        "images": images["c"],
        "bytes": images["b"],
        "history": history,
        "key": key,
        "recent": _recent_libraries(current),
    }


@router.get("/vertex")
def get_vertex():
    project, location = read_vertex()
    return {"project": project, "location": location, "configured": bool(project)}


@router.put("/vertex")
def put_vertex(body: VertexConfig, request: Request):
    require_admin(request, "Vertex settings are managed on the Mac.")
    project = body.project.strip()
    location = (body.location or DEFAULT_LOCATION).strip() or DEFAULT_LOCATION
    with get_conn() as conn:
        for key, value in ((PROJECT_KEY, project), (LOCATION_KEY, location)):
            put_setting(conn, key, value)
        conn.commit()
    return {"project": project, "location": location, "configured": bool(project)}


def _expire_library_request_locked(now: float) -> None:
    global _library_request
    if _library_request and now - _library_request["at"] > LIBRARY_REQUEST_TTL_S:
        _library_request = None


def library_request_snapshot() -> dict | None:
    with _library_request_lock:
        _expire_library_request_locked(time.time())
        return dict(_library_request) if _library_request else None


def ack_library_request(request_id: str) -> bool:
    global _library_request
    with _library_request_lock:
        _expire_library_request_locked(time.time())
        if not _library_request or _library_request["id"] != request_id:
            return False
        _library_request = None
    remote.bump_revision()
    return True


@router.post("/library/switch")
def switch_library(body: SwitchLibraryBody, request: Request):
    """Queue a recent-library switch for the desktop shell.

    The shell remains the authority: it re-checks the path against its own
    recent list and validates the library before stopping the current backend.
    """
    global _library_request
    if not remote.is_desktop() or not os.environ.get("IMAGEN_LIBRARY_MODE"):
        raise HTTPException(status_code=404, detail="Not found")
    current_role = role(request.scope)
    if current_role == "owner":
        raise HTTPException(status_code=404, detail="Not found")
    if current_role != "admin":
        raise HTTPException(status_code=403, detail="Library switching is managed on the Mac.")

    current = Path(DATA_DIR).resolve()
    recent = next(
        (item for item in _recent_libraries(current) if item["index"] == body.index),
        None,
    )
    if (
        recent is None
        or recent["id"] != body.id
        or not recent["exists"]
        or recent["path"] == str(current)
    ):
        return JSONResponse({"detail": "library_changed"}, status_code=409)

    devices, anonymous, mac = remote.running_by()
    running_by = list(devices)
    if anonymous:
        running_by.append({"device": "Remote", "n": anonymous})
    if mac:
        running_by.append({"device": remote.host_name(), "n": mac})
    from .desktop import _activity

    queued_mac = _activity()["queued_local"]
    running = remote.generating_total()
    if not body.force and (running > 0 or queued_mac > 0):
        return JSONResponse(
            {
                "detail": "busy",
                "running": running,
                "running_by": running_by,
                "queued_mac": queued_mac,
            },
            status_code=409,
        )

    sid = request.scope.get("state", {}).get("remote_session")
    session = remote.find_session_by_id(sid) if sid else None
    by = session["name"] if session else "Remote"
    with _library_request_lock:
        _expire_library_request_locked(time.time())
        if _library_request is not None:
            return JSONResponse({"detail": "switch_pending"}, status_code=409)
        _library_request = {
            "id": uuid.uuid4().hex,
            "path": recent["path"],
            "index": recent["index"],
            "by": by,
            "at": time.time(),
        }
    remote.bump_revision()
    logger.info("library switch requested by %s -> %s", by, recent["name"])
    return JSONResponse({"ok": True}, status_code=202)
