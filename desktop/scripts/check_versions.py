#!/usr/bin/env python3
"""Fail if the four user-visible version declarations disagree."""
from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    with (ROOT / "backend" / "pyproject.toml").open("rb") as fh:
        backend = tomllib.load(fh)["project"]["version"]
    with (ROOT / "desktop" / "package.json").open(encoding="utf-8") as fh:
        desktop = json.load(fh)["version"]
    with (ROOT / "desktop" / "src-tauri" / "Cargo.toml").open("rb") as fh:
        cargo = tomllib.load(fh)["package"]["version"]
    with (ROOT / "desktop" / "src-tauri" / "tauri.conf.json").open(encoding="utf-8") as fh:
        tauri = json.load(fh)["version"]

    versions = {
        "backend/pyproject.toml": backend,
        "desktop/package.json": desktop,
        "desktop/src-tauri/Cargo.toml": cargo,
        "desktop/src-tauri/tauri.conf.json": tauri,
    }
    for path, version in versions.items():
        print(f"  {path}: {version}")
    unique = set(versions.values())
    if len(unique) != 1:
        print(f"FAIL: version mismatch: {versions}", file=sys.stderr)
        return 1
    print(f"VERSION OK: {unique.pop()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
