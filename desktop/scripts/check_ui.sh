#!/usr/bin/env bash
# Pre-release UI checks: Playwright (Chromium, WebKit, phone viewport) against
# e2e_fake_backend.py on throwaway libraries built by e2e_build_library.py.
#
# Builds frontend/dist, syncs the backend venv, installs the e2e packages and
# the Playwright browsers (skipped when already present), then runs every test
# in e2e/. Extra arguments go to `playwright test` (e.g. --project=chromium,
# -g "usage", --headed).
#
# Nothing here calls Vertex or the Gemini API. Libraries live in e2e/.run
# (override with IMAGEN_E2E_RUN_DIR); ports stay in 47919-47927; backends are
# stopped by PID only. Report: e2e/playwright-report (traces, screenshots and
# videos of failures).
#
# Usage: desktop/scripts/check_ui.sh [playwright args...]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/e2e"
WORKERS="${IMAGEN_E2E_WORKERS:-$([ -n "${CI:-}" ] && echo 3 || echo 4)}"
export IMAGEN_E2E_WORKERS="$WORKERS"

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  printf '\nUI CHECK FAIL\n'
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "macOS only (desktop/scripts/fake_backend.py)"
case "$WORKERS" in ''|*[!0-9]*) fail "IMAGEN_E2E_WORKERS must be a number" ;; esac
[ "$WORKERS" -ge 1 ] && [ "$WORKERS" -le 8 ] || fail "IMAGEN_E2E_WORKERS must be 1-8"

# The template build uses 47919, workers use 47920 + index. Never touch a
# port someone else is listening on (8000/47860 are not in this range).
for port in 47919 $(seq 47920 $((47919 + WORKERS))); do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is in use; free it (the UI checks use 47919-$((47919 + WORKERS)))"
  fi
done

START=$(date +%s)

say "frontend: install + build"
(
  cd "$ROOT/frontend"
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci --no-audit --no-fund
  fi
  npm run build
) || fail "frontend build"

say "backend: uv sync"
(cd "$ROOT/backend" && uv sync --frozen) || fail "uv sync"

say "e2e: install packages"
(
  cd "$E2E"
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci --no-audit --no-fund
  fi
) || fail "e2e npm ci"

say "e2e: Playwright browsers (no-op when installed)"
(cd "$E2E" && npx playwright install chromium webkit) || fail "playwright install"

say "e2e: typecheck"
(cd "$E2E" && npx tsc --noEmit) || fail "e2e typecheck"

say "e2e: playwright test (workers=$WORKERS)"
(cd "$E2E" && npx playwright test "$@")
STATUS=$?

ELAPSED=$(( $(date +%s) - START ))
printf '\nReport: %s/playwright-report/index.html  (npx playwright show-report in e2e/)\n' "$E2E"
printf 'Elapsed: %dm%02ds\n' $((ELAPSED / 60)) $((ELAPSED % 60))
if [ "$STATUS" -ne 0 ]; then
  printf 'Backend logs: %s\n' "${IMAGEN_E2E_RUN_DIR:-$E2E/.run}/logs"
  printf '\nUI CHECK FAIL\n'
  exit "$STATUS"
fi
printf '\nUI CHECK PASS\n'
