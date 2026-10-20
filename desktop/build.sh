#!/usr/bin/env bash
# Build Imagen.app: frontend -> PyInstaller backend -> Tauri bundle.
#
# Usage (from anywhere):
#   desktop/build.sh          # app only
#   desktop/build.sh --dmg    # app + Imagen_<version>_aarch64.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MACOSX_DEPLOYMENT_TARGET=15.0
DO_DMG=0

case "${1:-}" in
  "") ;;
  --dmg) DO_DMG=1 ;;
  *) echo "usage: $0 [--dmg]" >&2; exit 2 ;;
esac

echo "==> version consistency"
python3 "$ROOT/desktop/scripts/check_versions.py"

echo "==> frontend dialog check"
"$ROOT/desktop/scripts/check_frontend.sh"

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
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$ROOT/desktop/src-tauri/tauri.conf.json")"
echo "==> built: $APP"
du -sh "$APP"

if [ "$DO_DMG" = "1" ]; then
  echo "==> DMG (Imagen_${VERSION}_aarch64.dmg)"
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/imagen-dmg-stage.XXXXXX")"
  MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/imagen-dmg-mount.XXXXXX")"
  OUT_DIR="$ROOT/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
  DMG="$OUT_DIR/Imagen_${VERSION}_aarch64.dmg"
  mkdir -p "$OUT_DIR"

  cleanup_dmg() {
    if mount | grep -q "on $MOUNT "; then
      hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    fi
    rm -rf "$STAGE" "$MOUNT"
  }
  trap cleanup_dmg EXIT

  ditto "$APP" "$STAGE/Imagen.app"
  ln -s /Applications "$STAGE/Applications"

  hdiutil create -volname Imagen -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

  echo "==> verify"
  hdiutil verify "$DMG" | tail -2

  hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG" >/dev/null
  MOUNTED_APP="$MOUNT/Imagen.app"
  [ -d "$MOUNTED_APP" ] || { echo "FAIL: Imagen.app missing from DMG" >&2; exit 1; }
  [ -L "$MOUNT/Applications" ] || { echo "FAIL: Applications symlink missing from DMG" >&2; exit 1; }

  SIGN="$(codesign -dv "$MOUNTED_APP" 2>&1 | sed -n 's/^Signature=//p' | head -1)"
  [ "$SIGN" = "adhoc" ] || { echo "FAIL: signature=$SIGN" >&2; exit 1; }
  ARCHS="$(lipo -archs "$MOUNTED_APP/Contents/MacOS/Imagen")"
  [ "$ARCHS" = "arm64" ] || { echo "FAIL: archs=$ARCHS" >&2; exit 1; }
  MIN="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' \
    "$MOUNTED_APP/Contents/Info.plist")"
  [ "$MIN" = "15.0" ] || { echo "FAIL: LSMinimumSystemVersion=$MIN" >&2; exit 1; }
  echo "DMG self-check: signature=adhoc archs=$ARCHS minimum=$MIN app=$(du -sh "$MOUNTED_APP" | awk '{print $1}')"

  hdiutil detach "$MOUNT" >/dev/null
  trap - EXIT
  rm -rf "$STAGE" "$MOUNT"

  echo "DMG: $DMG"
  echo "DMG size: $(du -h "$DMG" | awk '{print $1}')"
  echo "DMG sha256: $(shasum -a 256 "$DMG" | awk '{print $1}')"
fi
