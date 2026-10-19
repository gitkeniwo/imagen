# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the desktop backend (onedir, arm64 only).

Build from the repo root:

    cd backend && uv sync --group desktop && \
      uv run pyinstaller ../desktop/imagen-backend.spec \
        --distpath ../desktop/src-tauri/resources \
        --workpath ./build-desktop --noconfirm

Output: desktop/src-tauri/resources/imagen-backend/{imagen-backend,_internal/}
"""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND_DIST = ROOT / "frontend" / "dist"

if not (FRONTEND_DIST / "index.html").is_file():
    raise SystemExit(
        f"frontend build missing at {FRONTEND_DIST}; run `npm run build` in frontend/ first"
    )

# `collect_submodules` needs the package importable during analysis.
sys.path.insert(0, str(BACKEND))

hiddenimports = collect_submodules("app")
# uvicorn resolves these from strings at runtime (loop/http/lifespan), so
# PyInstaller's static analysis cannot see them.
hiddenimports += [
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on",
]

a = Analysis(
    [str(BACKEND / "app" / "desktop.py")],
    pathex=[str(BACKEND)],
    binaries=[],
    datas=[(str(FRONTEND_DIST), "frontend_dist")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # NOTE: `websockets` is deliberately NOT excluded. uvicorn never serves
    # WebSocket (ws="none"), but google-genai imports the package at module
    # import time, so excluding it breaks the frozen bundle at startup.
    excludes=["tkinter", "uvloop", "httptools", "watchfiles"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="imagen-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    target_arch="arm64",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="imagen-backend",
)
