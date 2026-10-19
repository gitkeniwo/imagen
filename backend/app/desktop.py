"""Desktop entry point for the bundled Imagen backend.

Run as ``python -m app.desktop`` from ``backend/`` or as the PyInstaller
entry script. Unlike the Docker/dev server this refuses to start without an
explicit data directory, binds loopback only, and can watch its parent
through stdin so it never outlives the Tauri shell.
"""
import multiprocessing
import os
import sys
import threading
from pathlib import Path

DEFAULT_PORT = 47860
PARENT_WATCH_TIMEOUT_S = 5.0


def _fail(message: str) -> int:
    print(f"imagen-backend: fatal: {message}", file=sys.stderr, flush=True)
    return 2


def _parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"IMAGEN_PORT must be an integer, got {raw!r}")
    if not 1 <= port <= 65535:
        raise ValueError(f"IMAGEN_PORT out of range: {port}")
    return port


def _force_exit() -> None:
    print(
        f"imagen-backend: shutdown still pending after {PARENT_WATCH_TIMEOUT_S:.0f}s, forcing exit",
        file=sys.stderr,
        flush=True,
    )
    os._exit(0)


def _watch_parent(server) -> None:
    """Block on stdin until EOF (= parent died) and ask uvicorn to stop."""
    stream = getattr(sys.stdin, "buffer", None)
    if stream is None:  # no stdin at all: nothing to watch
        print(
            "imagen-backend: IMAGEN_PARENT_WATCH set but stdin is unavailable",
            file=sys.stderr,
            flush=True,
        )
        return
    try:
        while stream.read(1):
            pass
    except (OSError, ValueError):
        pass
    print("imagen-backend: parent closed stdin, shutting down", file=sys.stderr, flush=True)
    server.should_exit = True
    timer = threading.Timer(PARENT_WATCH_TIMEOUT_S, _force_exit)
    timer.daemon = True
    timer.start()


def main() -> int:
    multiprocessing.freeze_support()

    # Must happen before importing app.db: db.py creates directories at import
    # time from IMAGEN_DATA_DIR, and a packaged binary without it would write
    # into the bundle.
    data_dir = (os.environ.get("IMAGEN_DATA_DIR") or "").strip()
    if not data_dir:
        return _fail(
            "IMAGEN_DATA_DIR is not set. The desktop backend refuses to start "
            "without an explicit data directory."
        )

    try:
        port = _parse_port(os.environ.get("IMAGEN_PORT") or str(DEFAULT_PORT))
    except ValueError as exc:
        return _fail(str(exc))

    # Support `python desktop/app/desktop.py` style direct execution; in the
    # frozen bundle and `python -m app.desktop` this is already importable.
    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    import uvicorn

    from app.main import app

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="on",
        access_log=False,
        log_level="info",
    )
    server = uvicorn.Server(config)

    if os.environ.get("IMAGEN_PARENT_WATCH") == "1":
        threading.Thread(target=_watch_parent, args=(server,), daemon=True).start()

    print(f"imagen-backend: listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
