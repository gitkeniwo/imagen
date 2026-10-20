"""Desktop-only library safety: validate, lock, and back up the image library.

Nothing in this module imports ``app.db``.  It must run before ``app.main`` is
imported so an invalid or missing library cannot be created as a side effect of
``DATA_DIR``/``init_storage``.
"""
from __future__ import annotations

import fcntl
import os
import re
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

SQLITE_HEADER = b"SQLite format 3\x00"
EXIT_INVALID = 3
EXIT_LOCKED = 4
BACKUP_KEEP = 7
BACKUP_RE = re.compile(r"^app-\d{8}-\d{6}\.db$")
_LOCK_HANDLE = None


class LibraryError(Exception):
    """A library validation/backup/lock failure with a process exit code."""

    def __init__(self, message: str, code: int = EXIT_INVALID):
        super().__init__(message)
        self.code = code


def _fail(message: str, code: int = EXIT_INVALID) -> None:
    raise LibraryError(message, code)


def _entries(path: Path) -> list[Path]:
    """Directory entries except macOS metadata, which does not make a dir non-empty."""
    return [
        entry
        for entry in path.iterdir()
        if entry.name not in {".DS_Store", ".synthetic"}
    ]


def _read_sqlite_header(db_path: Path) -> None:
    try:
        with db_path.open("rb") as fh:
            header = fh.read(len(SQLITE_HEADER))
    except OSError as exc:
        _fail(f"无法读取 app.db：{exc}")
    if header != SQLITE_HEADER:
        _fail("app.db 的文件头不是 SQLite format 3")


def _check_sqlite_tables(db_path: Path) -> None:
    """Open read-only and require the two core tables.  Never writes/migrates."""
    uri = f"file:{quote(str(db_path), safe='/')}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        try:
            rows = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name IN ('images', 'generations')"
                )
            }
        finally:
            conn.close()
    except sqlite3.Error as exc:
        _fail(f"无法只读打开 app.db：{exc}")
    missing = sorted({"images", "generations"} - rows)
    if missing:
        _fail(f"app.db 缺少表：{', '.join(missing)}")


def _validate_existing(path: Path) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=True)
    except OSError:
        _fail(f"图库不可用：目录不存在：{path}")
    if not resolved.is_dir():
        _fail(f"图库不可用：不是目录：{path}")
    db_path = resolved / "app.db"
    if not db_path.exists():
        _fail(f"图库不可用：缺少 app.db：{resolved}")
    if not db_path.is_file():
        _fail(f"图库不可用：app.db 不是普通文件：{db_path}")
    _read_sqlite_header(db_path)
    _check_sqlite_tables(db_path)
    return resolved


def _validate_create(path: Path) -> Path:
    path = path.expanduser()
    if path.is_symlink():
        _fail(f"新建图库不能使用软链接：{path}")
    if path.exists():
        if not path.is_dir():
            _fail(f"新建图库路径不是目录：{path}")
        if _entries(path):
            _fail(f"新建图库要求空目录（忽略 .DS_Store / .synthetic 测试标记）：{path}")
        return path.resolve()
    parent = path.parent
    if not parent.is_dir():
        _fail(f"新建图库的父目录不存在：{parent}")
    return path.resolve(strict=False)


def _acquire_lock(path: Path) -> None:
    """Hold LOCK_EX|LOCK_NB for the process lifetime.

    The handle is stored globally so it is not garbage collected.  Creating the
    lock file is the only write this module does before backup/init.
    """
    global _LOCK_HANDLE
    lock_path = path / ".imagen.lock"
    try:
        handle = lock_path.open("a+")
    except OSError as exc:
        _fail(f"无法创建图库锁文件：{exc}")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        _fail("图库正被另一个 Imagen 使用", EXIT_LOCKED)
    except OSError as exc:
        handle.close()
        _fail(f"无法锁定图库：{exc}")
    _LOCK_HANDLE = handle


def _backup_matches(backups: Path) -> list[Path]:
    if not backups.exists():
        return []
    if not backups.is_dir():
        _fail(f"backups 路径不是目录：{backups}")
    return sorted(
        (p for p in backups.iterdir() if p.is_file() and BACKUP_RE.fullmatch(p.name)),
        key=lambda p: p.name,
    )


def _backup_database(path: Path) -> Path | None:
    """Back up once per local calendar day, then keep only the newest 7 files."""
    backups = path / "backups"
    matches = _backup_matches(backups)
    today = datetime.now().strftime("%Y%m%d")
    if any(name.name.startswith(f"app-{today}-") for name in matches):
        target = None
    else:
        try:
            backups.mkdir(exist_ok=True)
        except OSError as exc:
            _fail(f"无法创建备份目录：{exc}")

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = backups / f"app-{stamp}.db"
        while target.exists():
            time.sleep(1)
            target = backups / f"app-{datetime.now():%Y%m%d-%H%M%S}.db"

        source = None
        destination = None
        try:
            source = sqlite3.connect(
                f"file:{quote(str(path / 'app.db'), safe='/')}?mode=ro",
                uri=True,
                timeout=30,
            )
            destination = sqlite3.connect(target)
            source.backup(destination)
            destination.commit()
        except (OSError, sqlite3.Error) as exc:
            if destination is not None:
                destination.close()
                destination = None
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            _fail(f"图库备份失败：{exc}")
        finally:
            if destination is not None:
                destination.close()
            if source is not None:
                source.close()

    # Re-scan so a concurrent/hand-made file is classified by the same rule.
    matches = _backup_matches(backups)
    for old in matches[:-BACKUP_KEEP]:
        try:
            old.unlink()
        except OSError as exc:
            _fail(f"无法清理旧备份 {old.name}：{exc}")
    return target


def prepare_library(raw_path: str, raw_mode: str) -> tuple[Path, str]:
    """Validate and prepare the library before importing app.db.

    Returns ``(resolved_path, mode)``.  Raises :class:`LibraryError` on any
    condition that must stop startup.  Existing mode never creates a directory
    or app.db; create mode only creates an empty selected directory.
    """
    path = Path(raw_path).expanduser()
    mode = (raw_mode or "").strip().lower()
    if mode == "auto":
        mode = "existing" if (path / "app.db").exists() else "create"
    if mode not in {"existing", "create"}:
        _fail(f"IMAGEN_LIBRARY_MODE 无效：{raw_mode!r}（只能是 existing/create/auto）")

    if mode == "existing":
        resolved = _validate_existing(path)
    else:
        resolved = _validate_create(path)
        try:
            resolved.mkdir()
        except FileExistsError:
            pass
        except OSError as exc:
            _fail(f"无法创建图库目录：{exc}")

    _acquire_lock(resolved)
    if mode == "existing":
        _backup_database(resolved)
    return resolved, mode
