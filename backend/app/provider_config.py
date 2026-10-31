"""Provider configuration: on/off switches, Vertex project and the Gemini key.

Switches and the Vertex project are non-secret and live in the library's
SQLite `settings` table. The Gemini API key never goes into `app.db` or the
library folder (libraries are moved around and backed up daily). Its sources,
in order:
  1. IMAGEN_GEMINI_API_KEY (Docker; read-only in the UI)
  2. secrets.json at IMAGEN_SECRETS_PATH (desktop; next to remote.json, 0600)
  3. process memory (dev / data-directory test mode; lost on restart)
Docker server mode (IMAGEN_ACCESS_CODE) only accepts the environment variable.
"""
import contextlib
import json
import logging
import os
import tempfile
import threading
from pathlib import Path

from . import remote
from .db import get_conn

logger = logging.getLogger("imagen.providers")

PROJECT_KEY = "vertex_project"
LOCATION_KEY = "vertex_location"
DEFAULT_LOCATION = "global"

# Default switch state when the library has never stored one.
DEFAULT_ENABLED = {"vertex": True, "gemini": False}

KEY_ENV = "IMAGEN_GEMINI_API_KEY"
SECRETS_VERSION = 1


class KeyFromEnv(Exception):
    """The key is set by the environment and cannot be changed here."""


class KeyEnvOnly(Exception):
    """This deployment only reads the key from the environment."""


def _get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row and row["value"] else None


def put_setting(conn, key: str, value: str) -> None:
    conn.execute(
        """INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
        (key, value),
    )


def read_vertex() -> tuple[str | None, str]:
    """Return (project, location); location falls back to the default."""
    with get_conn() as conn:
        project = _get(conn, PROJECT_KEY)
        location = _get(conn, LOCATION_KEY) or DEFAULT_LOCATION
    return project, location


# --- switches ----------------------------------------------------------------

def _enabled_key(provider_id: str) -> str:
    return f"provider_{provider_id}_enabled"


def enabled_map() -> dict[str, bool]:
    with get_conn() as conn:
        out = {}
        for pid, default in DEFAULT_ENABLED.items():
            raw = _get(conn, _enabled_key(pid))
            out[pid] = default if raw is None else raw == "1"
    return out


def is_enabled(provider_id: str) -> bool:
    return enabled_map().get(provider_id, False)


def set_enabled(provider_id: str, enabled: bool) -> dict[str, bool]:
    """Store one switch. Raises ValueError when it would turn the last one off."""
    current = enabled_map()
    nxt = {**current, provider_id: enabled}
    if not any(nxt.values()):
        raise ValueError("last_provider")
    with get_conn() as conn:
        put_setting(conn, _enabled_key(provider_id), "1" if enabled else "0")
    return nxt


# --- Gemini API key ------------------------------------------------------------

_lock = threading.Lock()
_memory_key: str | None = None


def _secrets_path() -> Path | None:
    if remote.is_server_auth():
        return None
    raw = os.environ.get("IMAGEN_SECRETS_PATH")
    return Path(raw) if raw else None


def _env_key() -> str | None:
    return (os.environ.get(KEY_ENV) or "").strip() or None


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".secrets-", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _read_file(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        logger.warning("ignoring unreadable secrets file %s: %s", path, type(e).__name__)
        return {}
    return data if isinstance(data, dict) else {}


def gemini_key() -> tuple[str | None, str | None]:
    """(key, source) with source in {"env", "saved", None}."""
    env = _env_key()
    if env:
        return env, "env"
    if remote.is_server_auth():
        return None, None
    path = _secrets_path()
    with _lock:
        if path is None:
            return (_memory_key, "saved") if _memory_key else (None, None)
        key = _read_file(path).get("gemini_api_key")
    if isinstance(key, str) and key:
        return key, "saved"
    return None, None


def key_storage() -> str:
    """Where a saved key goes: env | env_only | file | memory."""
    if _env_key():
        return "env"
    if remote.is_server_auth():
        return "env_only"
    return "file" if _secrets_path() is not None else "memory"


def _check_writable() -> None:
    if _env_key():
        raise KeyFromEnv()
    if remote.is_server_auth():
        raise KeyEnvOnly()


def set_gemini_key(key: str) -> None:
    global _memory_key
    _check_writable()
    path = _secrets_path()
    with _lock:
        if path is None:
            _memory_key = key
            return
        data = _read_file(path)
        data["version"] = SECRETS_VERSION
        data["gemini_api_key"] = key
        _atomic_write(path, data)


def delete_gemini_key() -> None:
    global _memory_key
    _check_writable()
    path = _secrets_path()
    with _lock:
        if path is None:
            _memory_key = None
            return
        data = _read_file(path)
        if "gemini_api_key" not in data:
            return
        data.pop("gemini_api_key")
        data["version"] = SECRETS_VERSION
        _atomic_write(path, data)


def last4(key: str | None) -> str | None:
    return key[-4:] if key else None
