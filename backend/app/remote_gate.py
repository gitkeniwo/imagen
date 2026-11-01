"""ASGI gate that applies the trust rules per listener.

Pure ASGI (no BaseHTTPMiddleware) so StreamingResponse bodies such as
/api/generate pass through unbuffered. The desktop build adds the LAN rules;
every build rejects DNS-rebinding hosts and cross-site writes, because any
web page open in the user's browser can send "simple" POSTs to localhost.
"""
import ipaddress
import os
import time
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse, RedirectResponse

from . import remote

# Reachable on the LAN listener without a session.
_PUBLIC_GET = {"/login", "/api/remote/hello"}
_PUBLIC_POST = {"/api/remote/login"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# The Vite dev server (separate origin) proxies /api here; see CORS in main.py.
_DEV_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}


def _header(scope, name: bytes) -> str:
    for key, value in scope["headers"]:
        if key == name:
            return value.decode("latin-1")
    return ""


def _cookie_token(scope) -> str | None:
    raw = _header(scope, b"cookie")
    if not raw:
        return None
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:  # noqa: BLE001
        return None
    morsel = jar.get(remote.COOKIE_NAME)
    return morsel.value if morsel else None


def _foreign_origin(scope, host: str, extra: set[str] = frozenset()) -> bool:
    """True when a browser sent this request from another site.

    Browsers attach Origin to every non-GET request, cross-site no-cors ones
    included (sandboxed pages send "null"). A missing header means a non-browser
    client such as curl or the desktop shell, which is not a CSRF vector.
    """
    origin = _header(scope, b"origin")
    if not origin:
        return False
    return urlsplit(origin).netloc.lower() != host and origin.lower() not in extra


def _allowed_host(host: str) -> bool:
    """Host header check for the non-desktop server (Docker / dev).

    DNS rebinding needs a domain name that resolves to this machine, so IP
    literals and localhost are always fine. Other names (a reverse proxy, a
    .local name) must be listed in IMAGEN_ALLOWED_HOSTS; "*" turns this off.
    """
    name = urlsplit(f"//{host}").hostname or ""
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    allowed = {
        h.strip().lower()
        for h in os.environ.get("IMAGEN_ALLOWED_HOSTS", "").split(",")
        if h.strip()
    }
    return "*" in allowed or name in allowed


async def _deny(scope, receive, send, detail: str) -> None:
    await JSONResponse({"detail": detail}, status_code=403)(scope, receive, send)


def is_lan(scope) -> bool:
    """True when the request arrived on the LAN listener (anything but loopback)."""
    return bool((scope.get("state") or {}).get("remote"))


def role(scope) -> str:
    """Owner for loopback/server mode, otherwise the LAN session's role."""
    if not is_lan(scope):
        return "owner"
    sid = (scope.get("state") or {}).get("remote_session")
    # Open-access visits have no session and must never gain admin.
    return remote.session_role(sid)


def require_admin(
    request: Request,
    detail: str = "This setting is managed on the Mac.",
) -> str:
    """Return the requester's role or reject members with a route-specific message."""
    current = role(request.scope)
    if current not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail=detail)
    return current


class RemoteGate:
    def __init__(self, app):
        self.app = app
        self.enabled = remote.is_desktop()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        host = _header(scope, b"host").lower()
        unsafe = scope["method"] not in _SAFE_METHODS

        if not self.enabled:
            if not _allowed_host(host):
                await _deny(scope, receive, send, "bad_host")
                return
            if remote.is_server_auth():
                await self._login_required(scope, receive, send, host, lan=False)
                return
            if unsafe and _foreign_origin(scope, host, _DEV_ORIGINS):
                await _deny(scope, receive, send, "bad_origin")
                return
            await self.app(scope, receive, send)
            return

        server = scope.get("server") or (None, None)
        port = server[1]
        scope.setdefault("state", {})

        if port == remote.loopback_port():
            # DNS rebinding: a hostile page can point its own name at 127.0.0.1.
            if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                await _deny(scope, receive, send, "bad_host")
                return
            # CSRF: a page on another site can still POST here by IP.
            if unsafe and _foreign_origin(scope, host):
                await _deny(scope, receive, send, "bad_origin")
                return
            await self.app(scope, receive, send)
            return

        await self._login_required(scope, receive, send, host, lan=True)

    async def _login_required(self, scope, receive, send, host: str, lan: bool) -> None:
        """The LAN listener's rules; also every request in server mode.

        Server-mode sessions are not marked `remote`: they are the owner's own
        devices and keep full access (Vertex settings etc.).
        """
        method = scope["method"]
        path = scope["path"]
        client = scope.get("client") or ("", 0)
        ip = client[0]
        scope.setdefault("state", {})
        scope["state"]["remote"] = lan

        if method not in _SAFE_METHODS:
            origin = _header(scope, b"origin")
            if not origin or urlsplit(origin).netloc.lower() != host:
                await _deny(scope, receive, send, "bad_origin")
                return

        cfg = remote.config()
        session = remote.find_session(_cookie_token(scope))
        scope["state"]["remote_session"] = session["id"] if session else None

        public = (
            (method in ("GET", "HEAD") and (path in _PUBLIC_GET or path.startswith("/assets/")))
            or (method == "POST" and path in _PUBLIC_POST)
            # Docker HEALTHCHECK; without the desktop token it says nothing.
            or (not lan and method in ("GET", "HEAD") and path == "/api/health")
        )
        if not (public or session or not cfg["require_code"]):
            if path.startswith("/api/"):
                await JSONResponse(
                    {"detail": "remote_auth_required"}, status_code=401
                )(scope, receive, send)
            else:
                await RedirectResponse("/login", status_code=302)(scope, receive, send)
            return

        remote.touch(session, ip)

        refresh_cookie = False
        if session and session.get("role") == "admin" and path != "/api/remote/logout":
            now = time.monotonic()
            last = session.get("_cookie_refreshed")
            if last is None:
                session["_cookie_refreshed"] = now
                refresh_cookie = True
            elif now - last > 24 * 3600:
                session["_cookie_refreshed"] = now
                refresh_cookie = True

        token = _cookie_token(scope)
        if not refresh_cookie or not token:
            await self.app(scope, receive, send)
            return

        async def send_with_cookie(message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                cookie = (
                    f"{remote.COOKIE_NAME}={token}; Max-Age={remote.ADMIN_IDLE_MAX_S}; "
                    "Path=/; HttpOnly; SameSite=Strict"
                )
                headers.append((b"set-cookie", cookie.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_cookie)
