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


def _fail(message: str, code: int = 2) -> int:
    print(f"imagen-backend: fatal: {message}", file=sys.stderr, flush=True)
    return code


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
    """Block on stdin until EOF (= parent died) and ask uvicorn to stop.

    Uses a raw ``os.read`` instead of the buffered reader: when uvicorn exits
    on its own (for example the port is already taken) and Python finalizes
    while this daemon thread is still blocked, the buffered reader's internal
    lock aborts the interpreter (``_enter_buffered_busy``). A raw fd read has
    no such lock.
    """
    try:
        fd = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        print(
            "imagen-backend: IMAGEN_PARENT_WATCH set but stdin is unavailable",
            file=sys.stderr,
            flush=True,
        )
        return
    try:
        while os.read(fd, 1):
            pass
    except (OSError, ValueError):
        pass
    print("imagen-backend: parent closed stdin, shutting down", file=sys.stderr, flush=True)
    server.should_exit = True
    # Release the shell's long-poll immediately; otherwise uvicorn's graceful
    # shutdown waits for that request (up to its 25 s hold).
    try:
        from app import remote

        remote.bump_revision()
    except Exception:  # noqa: BLE001 — shutdown must never fail here
        pass
    timer = threading.Timer(PARENT_WATCH_TIMEOUT_S, _force_exit)
    timer.daemon = True
    timer.start()


def build_server(app, port: int):
    """Build the uvicorn server with the frozen-friendly settings.

    Explicit loop/http/ws implementations avoid uvicorn's dynamic imports so
    PyInstaller needs no extra hidden imports. Shared with the test backend.
    """
    import uvicorn

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
        # A held long-poll must not delay quitting by its full timeout.
        timeout_graceful_shutdown=2,
    )
    return uvicorn.Server(config)


def start_parent_watch(server) -> None:
    """Start the stdin-EOF watcher when the shell asked for it."""
    if os.environ.get("IMAGEN_PARENT_WATCH") == "1":
        threading.Thread(target=_watch_parent, args=(server,), daemon=True).start()


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

    # Validate the library, take the single-instance lock, and back it up
    # BEFORE importing app.main/app.db or running init_storage.  An invalid
    # path therefore cannot be created or initialized as a side effect.
    try:
        from app.library import LibraryError, prepare_library

        library_path, library_mode = prepare_library(
            data_dir, os.environ.get("IMAGEN_LIBRARY_MODE") or "auto"
        )
    except LibraryError as exc:
        return _fail(str(exc), exc.code)
    except Exception as exc:  # defensive: never continue with an unvalidated library
        return _fail(f"图库准备失败：{exc}", 3)

    os.environ["IMAGEN_DATA_DIR"] = str(library_path)
    os.environ["IMAGEN_LIBRARY_MODE"] = library_mode
    print(
        f"imagen-backend: library mode={library_mode} path={library_path}",
        file=sys.stderr,
        flush=True,
    )

    from app.main import app

    server = build_server(app, port)
    start_parent_watch(server)

    print(f"imagen-backend: listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
