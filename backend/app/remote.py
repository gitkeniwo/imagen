"""LAN remote access for the desktop build.

The desktop backend always serves the app on loopback (the Tauri shell). When
the user switches remote access on, this module starts a *second* uvicorn
server in the same process, bound to 0.0.0.0 on its own port, serving the same
FastAPI app. Which listener a request arrived on decides trust: loopback is the
local shell, anything on the LAN port must hold a session cookie (unless the
user turned the access code off).

State lives in ``remote.json`` (path from IMAGEN_REMOTE_PATH, next to the
shell's desktop.json, never inside the library). Without that env var — data
directory test mode — it is kept in memory only.
"""
import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

logger = logging.getLogger("imagen.remote")

DEFAULT_PORT = 47861
COOKIE_NAME = "imagen_remote"
COOKIE_MAX_AGE = 30 * 24 * 3600
CODE_LENGTH = 5

ACTIVE_WINDOW_S = 60.0
SESSION_FLUSH_INTERVAL_S = 60.0
LOGIN_DELAY_S = 0.3

LOCK_AFTER_FAILURES = 5
LOCK_BASE_S = 60.0
LOCK_MAX_S = 900.0
GLOBAL_FAILURE_LIMIT = 50
FAILURE_WINDOW_S = 3600.0

KEEP_AWAKE_IDLE_S = 600.0
KEEP_AWAKE_CHECK_S = 30.0

_DEFAULTS = {
    "version": 1,
    "enabled": False,
    "port": DEFAULT_PORT,
    "require_code": True,
    "code": None,
    "keep_awake": True,
    "sessions": [],
}

_lock = threading.RLock()
_cfg: dict | None = None
_sessions: dict[str, dict] = {}
_last_flush = 0.0

# In-memory only: rate limiting and activity.
_ip_failures: dict[str, dict] = {}
_failure_times: deque[float] = deque()
_global_failures = 0
_disabled_reason: str | None = None
_last_activity = 0.0
_running: dict[str, int] = {}
# Every /api/generate request currently being processed, loopback or LAN.
# Independent of `_running`, which only tracks LAN sessions. Read by the
# desktop shell through /api/desktop/activity (menubar icon + quit guard).
_generating_total = 0


def is_desktop() -> bool:
    """Remote access exists only in the desktop build (shell sets the mode)."""
    return bool(os.environ.get("IMAGEN_LIBRARY_MODE"))


def loopback_port() -> int:
    try:
        return int(os.environ.get("IMAGEN_PORT") or 47860)
    except ValueError:
        return 47860


# --- config persistence -----------------------------------------------------

def _path() -> Path | None:
    raw = os.environ.get("IMAGEN_REMOTE_PATH")
    return Path(raw) if raw else None


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".remote-", suffix=".tmp")
    try:
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


def _load() -> dict:
    global _cfg, _sessions
    with _lock:
        if _cfg is not None:
            return _cfg
        cfg = dict(_DEFAULTS)
        path = _path()
        if path is not None:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    cfg.update({k: data[k] for k in _DEFAULTS if k in data})
            except (OSError, ValueError):
                pass
        port = cfg.get("port")
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            cfg["port"] = DEFAULT_PORT
        sessions = {}
        for item in cfg.get("sessions") or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                sessions[item["id"]] = {
                    "id": item["id"],
                    "name": str(item.get("name") or "Unknown device"),
                    "created_at": float(item.get("created_at") or 0),
                    "last_seen": float(item.get("last_seen") or 0),
                    "last_ip": str(item.get("last_ip") or ""),
                    "ua": str(item.get("ua") or ""),
                }
        _sessions = sessions
        cfg["sessions"] = []
        _cfg = cfg
        return cfg


def _save() -> None:
    global _last_flush
    with _lock:
        cfg = _load()
        path = _path()
        _last_flush = time.monotonic()
        if path is None:
            return
        try:
            _atomic_write(path, {**cfg, "sessions": list(_sessions.values())})
        except OSError:
            logger.exception("could not write remote.json")


def config() -> dict:
    with _lock:
        return dict(_load())


def _new_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_LENGTH):0{CODE_LENGTH}d}"


# --- sessions ---------------------------------------------------------------

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _clean_name(name: str | None) -> str:
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", name or "").strip()
    return cleaned[:40] or "Unknown device"


def create_session(name: str | None, ip: str, ua: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        _load()
        sid = _hash(token)
        _sessions[sid] = {
            "id": sid,
            "name": _clean_name(name),
            "created_at": now,
            "last_seen": now,
            "last_ip": ip,
            "ua": ua[:200],
        }
        _save()
    return token


def find_session(token: str | None) -> dict | None:
    if not token:
        return None
    with _lock:
        _load()
        session = _sessions.get(_hash(token))
        if session and time.time() - session["created_at"] > COOKIE_MAX_AGE:
            del _sessions[session["id"]]
            _save()
            return None
        return session


def find_session_by_id(sid: str) -> dict | None:
    with _lock:
        _load()
        return _sessions.get(sid)


def touch(session: dict | None, ip: str) -> None:
    """Record a LAN request; last_seen reaches disk at most once a minute."""
    global _last_activity
    _last_activity = time.monotonic()
    if session is None:
        return
    with _lock:
        session["last_seen"] = time.time()
        session["last_ip"] = ip
        if time.monotonic() - _last_flush > SESSION_FLUSH_INTERVAL_S:
            _save()


def revoke_session(sid: str) -> bool:
    with _lock:
        _load()
        if _sessions.pop(sid, None) is None:
            return False
        _save()
        return True


def revoke_all() -> None:
    with _lock:
        _load()
        _sessions.clear()
        _save()


def session_started(sid: str | None) -> str:
    key = sid or "-"
    with _lock:
        _running[key] = _running.get(key, 0) + 1
    return key


def session_finished(key: str) -> None:
    with _lock:
        left = _running.get(key, 0) - 1
        if left > 0:
            _running[key] = left
        else:
            _running.pop(key, None)


def generation_started() -> None:
    """A /api/generate request passed validation and is about to run."""
    global _generating_total
    with _lock:
        _generating_total += 1


def generation_finished() -> None:
    global _generating_total
    with _lock:
        if _generating_total > 0:
            _generating_total -= 1


def generating_total() -> int:
    with _lock:
        return _generating_total


# --- login + rate limiting --------------------------------------------------

def _prune_failures(now: float) -> None:
    while _failure_times and now - _failure_times[0] > FAILURE_WINDOW_S:
        _failure_times.popleft()


def check_locked(ip: str) -> float:
    """Seconds left on this IP's lock, or 0."""
    with _lock:
        entry = _ip_failures.get(ip)
        if not entry:
            return 0.0
        return max(0.0, entry["locked_until"] - time.monotonic())


def verify_code(code: str, ip: str) -> dict:
    """Check a submitted code. Returns {ok} | {error, remaining|retry_after}."""
    global _global_failures
    with _lock:
        cfg = _load()
        wait = check_locked(ip)
        if wait > 0:
            return {"error": "locked", "retry_after": int(wait) + 1}
        expected = cfg.get("code") or ""
        if not cfg["require_code"] or hmac.compare_digest(
            code.encode("utf-8"), expected.encode("utf-8")
        ):
            _ip_failures.pop(ip, None)
            return {"ok": True}

        now = time.monotonic()
        entry = _ip_failures.setdefault(ip, {"n": 0, "locked_until": 0.0})
        entry["n"] += 1
        _failure_times.append(now)
        _prune_failures(now)
        _global_failures += 1
        if _global_failures >= GLOBAL_FAILURE_LIMIT:
            _disable_locked("too_many_attempts")
            return {"error": "locked", "retry_after": int(LOCK_MAX_S)}
        if entry["n"] >= LOCK_AFTER_FAILURES:
            lock_s = min(LOCK_BASE_S * 2 ** (entry["n"] - LOCK_AFTER_FAILURES), LOCK_MAX_S)
            entry["locked_until"] = now + lock_s
            return {"error": "locked", "retry_after": int(lock_s)}
        return {"error": "wrong_code", "remaining": LOCK_AFTER_FAILURES - entry["n"]}


def failed_last_hour() -> int:
    with _lock:
        _prune_failures(time.monotonic())
        return len(_failure_times)


def _disable_locked(reason: str) -> None:
    """Switch remote access off from inside the failure path (lock held)."""
    global _disabled_reason
    cfg = _load()
    cfg["enabled"] = False
    _disabled_reason = reason
    _save()
    loop = _loop
    if loop is not None and loop.is_running():
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_stop_listener()))


# --- network info -----------------------------------------------------------

_net_cache: tuple[float, dict] | None = None
_NET_TTL_S = 5.0


def _run(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _private_kind(ip: str) -> str | None:
    """'lan' for RFC1918, 'cgnat' for 100.64/10, None otherwise."""
    try:
        a, b, *_ = (int(p) for p in ip.split("."))
    except ValueError:
        return None
    if a == 10 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31):
        return "lan"
    if a == 100 and 64 <= b <= 127:
        return "cgnat"
    return None


def _port_names() -> dict[str, str]:
    names: dict[str, str] = {}
    port = None
    for line in _run(["/usr/sbin/networksetup", "-listallhardwareports"]).splitlines():
        if line.startswith("Hardware Port:"):
            port = line.split(":", 1)[1].strip()
        elif line.startswith("Device:") and port:
            names[line.split(":", 1)[1].strip()] = port
    return names


def _addresses() -> list[dict]:
    names = _port_names()
    out: list[dict] = []
    iface = None
    for line in _run(["/sbin/ifconfig"]).splitlines():
        if line and not line[0].isspace():
            iface = line.split(":", 1)[0]
            continue
        m = re.match(r"\s+inet (\d+\.\d+\.\d+\.\d+) ", line)
        if not m or not iface:
            continue
        ip = m.group(1)
        kind = _private_kind(ip)
        if kind is None or ip.startswith("169.254."):
            continue
        if kind == "cgnat" and iface.startswith("utun"):
            label = "tailscale"
        elif kind == "cgnat":
            label = "other"
        else:
            hw = names.get(iface, "")
            if "Wi-Fi" in hw or "AirPort" in hw:
                label = "wifi"
            elif "Ethernet" in hw or "Thunderbolt" in hw or "LAN" in hw:
                label = "ethernet"
            else:
                label = "other"
        out.append({"iface": iface, "ip": ip, "kind": label})
    # Wi-Fi / Ethernet first, Tailscale last: the first row is what to type.
    order = {"wifi": 0, "ethernet": 1, "other": 2, "tailscale": 3}
    return sorted(out, key=lambda a: order[a["kind"]])


def _scutil(key: str) -> str:
    return _run(["/usr/sbin/scutil", "--get", key]).strip()


def network_info() -> dict:
    global _net_cache
    now = time.monotonic()
    if _net_cache and now - _net_cache[0] < _NET_TTL_S:
        return _net_cache[1]
    local = _scutil("LocalHostName")
    info = {
        "addresses": _addresses(),
        "local_name": f"{local}.local" if local else None,
        "host_name": _scutil("ComputerName") or local or "Mac",
    }
    _net_cache = (now, info)
    return info


def host_name() -> str:
    return network_info()["host_name"]


def firewall_state() -> str:
    """'blocked' when block-all is on, 'ok' when readable, else 'unknown'."""
    tool = "/usr/libexec/ApplicationFirewall/socketfilterfw"
    if not os.path.exists(tool):
        return "unknown"
    out = _run([tool, "--getblockall"]).lower()
    if not out:
        return "unknown"
    if "set to enabled" in out or "block all enabled" in out:
        return "blocked"
    return "ok"


# --- LAN listener -----------------------------------------------------------

_loop: asyncio.AbstractEventLoop | None = None
_server = None
_task: asyncio.Task | None = None
_sock: socket.socket | None = None
_listener_error: str | None = None
_listener_port: int | None = None
_listener_lock: asyncio.Lock | None = None
_awake_task: asyncio.Task | None = None
_caffeinate: subprocess.Popen | None = None


def _make_server(app, sock: socket.socket, port: int):
    import uvicorn

    class _LanServer(uvicorn.Server):
        # The primary server owns SIGINT/SIGTERM; a second serve() must not
        # replace those handlers.
        def capture_signals(self):
            return contextlib.nullcontext()

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="off",
        access_log=False,
        log_level="warning",
        timeout_graceful_shutdown=2,
    )
    return _LanServer(config)


async def _serve(server, sock: socket.socket) -> None:
    global _listener_error
    try:
        await server.serve(sockets=[sock])
    except Exception as exc:  # noqa: BLE001
        logger.exception("LAN listener crashed")
        _listener_error = f"crashed: {exc}"
    finally:
        with contextlib.suppress(OSError):
            sock.close()


async def _start_listener(app) -> None:
    global _server, _task, _sock, _listener_error, _listener_port
    async with _listener_lock_get():
        if _task is not None and not _task.done():
            return
        port = _load()["port"]
        _listener_error = None
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", port))
            sock.listen(128)
            sock.setblocking(False)
        except OSError as exc:
            sock.close()
            _listener_error = "port_in_use" if exc.errno in (48, 98) else f"bind: {exc}"
            logger.warning("LAN listener could not bind port %s: %s", port, exc)
            return
        _sock = sock
        _listener_port = port
        _server = _make_server(app, sock, port)
        _task = asyncio.create_task(_serve(_server, sock))
        logger.info("LAN listener on 0.0.0.0:%s", port)


async def _stop_listener() -> None:
    global _server, _task, _sock, _listener_port
    async with _listener_lock_get():
        server, task = _server, _task
        _server = _task = _sock = None
        _listener_port = None
        if server is not None:
            server.should_exit = True
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=6)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                if server is not None:
                    server.force_exit = True
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(task, timeout=2)


def _listener_lock_get() -> asyncio.Lock:
    global _listener_lock
    if _listener_lock is None:
        _listener_lock = asyncio.Lock()
    return _listener_lock


def listening() -> bool:
    return _task is not None and not _task.done()


async def apply_config(app) -> None:
    """Make the listener match ``enabled`` / ``port`` (idempotent)."""
    cfg = _load()
    if cfg["enabled"]:
        if listening() and _listener_port != cfg["port"]:
            await _stop_listener()
        await _start_listener(app)
    else:
        await _stop_listener()
    _sync_keep_awake()


async def startup(app) -> None:
    global _loop, _awake_task
    _loop = asyncio.get_running_loop()
    _load()
    await apply_config(app)
    _awake_task = asyncio.create_task(_keep_awake_loop())


async def shutdown() -> None:
    if _awake_task is not None:
        _awake_task.cancel()
    _stop_caffeinate()
    await _stop_listener()


# --- keep awake -------------------------------------------------------------

def _active_generations() -> int:
    with _lock:
        return sum(_running.values())


def _want_awake() -> bool:
    cfg = _load()
    if not (cfg["enabled"] and cfg["keep_awake"]):
        return False
    recent = _last_activity > 0 and time.monotonic() - _last_activity < KEEP_AWAKE_IDLE_S
    return recent or _active_generations() > 0


def _stop_caffeinate() -> None:
    global _caffeinate
    proc, _caffeinate = _caffeinate, None
    if proc is not None and proc.poll() is None:
        proc.terminate()
        with contextlib.suppress(subprocess.SubprocessError):
            proc.wait(timeout=2)


def _sync_keep_awake() -> None:
    global _caffeinate
    if sys.platform != "darwin" or not shutil.which("caffeinate"):
        return
    if _want_awake():
        if _caffeinate is None or _caffeinate.poll() is not None:
            # -w ties the assertion to this process, so a crash can't leak it.
            _caffeinate = subprocess.Popen(
                ["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    else:
        _stop_caffeinate()


def keeping_awake() -> bool:
    return _caffeinate is not None and _caffeinate.poll() is None


async def _keep_awake_loop() -> None:
    while True:
        await asyncio.sleep(KEEP_AWAKE_CHECK_S)
        try:
            _sync_keep_awake()
        except Exception:  # noqa: BLE001
            logger.exception("keep-awake check failed")


# --- status + mutations (loopback API) -------------------------------------

def status() -> dict:
    cfg = config()
    net = network_info()
    fw = firewall_state()
    now = time.time()
    devices = []
    with _lock:
        for s in sorted(_sessions.values(), key=lambda s: -s["last_seen"]):
            devices.append({
                "id": s["id"],
                "name": s["name"],
                "ip": s["last_ip"],
                "created_at": s["created_at"],
                "last_seen": s["last_seen"],
                "active": now - s["last_seen"] < ACTIVE_WINDOW_S,
                "running": _running.get(s["id"], 0),
            })
        anon_running = _running.get("-", 0)
        recent = _last_activity > 0 and time.monotonic() - _last_activity < ACTIVE_WINDOW_S

    reason = None
    if not cfg["enabled"]:
        state = "off"
        reason = _disabled_reason
    elif _listener_error:
        state, reason = "blocked", _listener_error
    elif fw == "blocked":
        state, reason = "blocked", "firewall"
    elif not net["addresses"]:
        state, reason = "blocked", "no_network"
    elif not cfg["require_code"]:
        state = "no_code"
    elif any(d["active"] for d in devices):
        state = "active"
    else:
        state = "idle"
    return {
        "available": True,
        "enabled": cfg["enabled"],
        "state": state,
        "reason": reason,
        "port": cfg["port"],
        "require_code": cfg["require_code"],
        "code": cfg["code"],
        "addresses": net["addresses"],
        "local_name": net["local_name"],
        "host_name": net["host_name"],
        "devices": devices,
        "anon_active": recent and not cfg["require_code"],
        "anon_running": anon_running,
        "failed_last_hour": failed_last_hour(),
        "keep_awake": cfg["keep_awake"],
        "awake_now": keeping_awake(),
        "firewall": fw,
    }


async def update_config(app, patch: dict) -> None:
    """Apply a partial config change and reconcile the listener."""
    global _global_failures, _disabled_reason
    with _lock:
        cfg = _load()
        if "port" in patch and patch["port"] is not None:
            cfg["port"] = int(patch["port"])
        if "require_code" in patch and patch["require_code"] is not None:
            cfg["require_code"] = bool(patch["require_code"])
        if "keep_awake" in patch and patch["keep_awake"] is not None:
            cfg["keep_awake"] = bool(patch["keep_awake"])
        if patch.get("enabled") is not None:
            turning_on = bool(patch["enabled"]) and not cfg["enabled"]
            cfg["enabled"] = bool(patch["enabled"])
            if turning_on:
                _global_failures = 0
                _disabled_reason = None
        if cfg["enabled"] and not cfg["code"]:
            cfg["code"] = _new_code()
        _save()
    await apply_config(app)


def regenerate_code() -> str:
    """New code and every signed-in device is signed out."""
    with _lock:
        cfg = _load()
        cfg["code"] = _new_code()
        _sessions.clear()
        _save()
        return cfg["code"]
