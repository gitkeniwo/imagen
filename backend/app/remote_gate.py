"""ASGI gate that applies the remote-access trust rules per listener.

Pure ASGI (no BaseHTTPMiddleware) so StreamingResponse bodies such as
/api/generate pass through unbuffered. Only active in the desktop build.
"""
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from starlette.responses import JSONResponse, RedirectResponse

from . import remote

# Reachable on the LAN listener without a session.
_PUBLIC_GET = {"/login", "/api/remote/hello"}
_PUBLIC_POST = {"/api/remote/login"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


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


def is_lan(scope) -> bool:
    """True when the request arrived on the LAN listener (anything but loopback)."""
    return bool((scope.get("state") or {}).get("remote"))


class RemoteGate:
    def __init__(self, app):
        self.app = app
        self.enabled = remote.is_desktop()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.enabled:
            await self.app(scope, receive, send)
            return

        server = scope.get("server") or (None, None)
        port = server[1]
        scope.setdefault("state", {})
        host = _header(scope, b"host").lower()

        if port == remote.loopback_port():
            # DNS rebinding: a hostile page can point its own name at 127.0.0.1.
            if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                await JSONResponse({"detail": "bad_host"}, status_code=403)(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        await self._lan(scope, receive, send, host)

    async def _lan(self, scope, receive, send, host: str) -> None:
        method = scope["method"]
        path = scope["path"]
        client = scope.get("client") or ("", 0)
        ip = client[0]
        scope["state"]["remote"] = True

        if method not in _SAFE_METHODS:
            origin = _header(scope, b"origin")
            if not origin or urlsplit(origin).netloc.lower() != host:
                await JSONResponse({"detail": "bad_origin"}, status_code=403)(scope, receive, send)
                return

        cfg = remote.config()
        session = remote.find_session(_cookie_token(scope))
        scope["state"]["remote_session"] = session["id"] if session else None

        public = (
            (method in ("GET", "HEAD") and (path in _PUBLIC_GET or path.startswith("/assets/")))
            or (method == "POST" and path in _PUBLIC_POST)
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
        await self.app(scope, receive, send)
