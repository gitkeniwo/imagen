#!/usr/bin/env bash
# Build Imagen.app: frontend -> PyInstaller backend -> Tauri bundle.
#
# Usage (from anywhere): desktop/build.sh
# Output: desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Imagen.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MACOSX_DEPLOYMENT_TARGET=15.0

echo "==> frontend (npm ci && npm run build)"
(cd "$ROOT/frontend" && npm ci && npm run build)

echo "==> backend (PyInstaller onedir)"
rm -rf "$ROOT/desktop/src-tauri/resources/imagen-backend"
(cd "$ROOT/backend" && uv sync --group desktop --frozen && \
  uv run pyinstaller ../desktop/imagen-backend.spec \
    --distpath ../desktop/src-tauri/resources \
    --workpath ./build-desktop --noconfirm)

echo "==> Tauri bundle (aarch64-apple-darwin, app only)"
(cd "$ROOT/desktop" && npm ci && npx tauri build --target aarch64-apple-darwin --bundles app)

APP="$ROOT/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Imagen.app"
echo "==> built: $APP"
du -sh "$APP"
