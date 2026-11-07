#!/usr/bin/env bash
# Everything that must pass before a release tag: the backend/shell checks and
# the Playwright UI checks, in order. Every check runs (so one report shows all
# failures); the script exits non-zero if any of them failed.
#
# Nothing here calls Vertex or the Gemini API, touches backend/data or
# ~/.config/imagen, or stops a process it did not start. Ports: 47901-47999.
#
# Usage: desktop/scripts/release_check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$ROOT/desktop/scripts"
LOG_DIR="${RELEASE_CHECK_LOG_DIR:-$ROOT/e2e/.release-check}"
mkdir -p "$LOG_DIR"

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# The shell checks run the backend from its venv.
if ! (cd "$ROOT/backend" && uv sync --frozen); then
  echo "FAIL: uv sync" >&2
  printf '\nRELEASE CHECK FAIL\n'
  exit 1
fi

# check_roles (and others) serve frontend/dist; build it before any check.
if ! (cd "$ROOT/frontend" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build); then
  echo "FAIL: frontend build" >&2
  printf '\nRELEASE CHECK FAIL\n'
  exit 1
fi

CHECKS=(check_frontend check_roles check_providers check_generate_stream smoke_backend check_ui)
RESULTS=()
FAILED=0
START=$(date +%s)

for name in "${CHECKS[@]}"; do
  printf '\n######## %s\n' "$name"
  t0=$(date +%s)
  if [ "$name" = smoke_backend ]; then
    busy=""
    for port in 47911 47912 47913; do port_free "$port" || busy="$busy $port"; done
    if [ -n "$busy" ]; then
      echo "FAIL: smoke_backend needs ports 47911/47912/47913; in use:$busy" >&2
      RESULTS+=("FAIL  $name (ports in use:$busy)")
      FAILED=1
      continue
    fi
  fi
  script="$S/$name.sh"
  # Tee so CI shows the output live and keeps a per-check log for upload.
  bash "$script" 2>&1 | tee "$LOG_DIR/$name.log"
  status=${PIPESTATUS[0]}
  dt=$(( $(date +%s) - t0 ))
  if [ "$status" -eq 0 ]; then
    RESULTS+=("PASS  $name (${dt}s)")
  else
    RESULTS+=("FAIL  $name (${dt}s, exit $status)")
    FAILED=1
  fi
done

ELAPSED=$(( $(date +%s) - START ))
printf '\n######## summary (%dm%02ds)\n' $((ELAPSED / 60)) $((ELAPSED % 60))
printf '%s\n' "${RESULTS[@]}"
printf 'Logs: %s\n' "$LOG_DIR"
if [ "$FAILED" -ne 0 ]; then
  printf '\nRELEASE CHECK FAIL\n'
  exit 1
fi
printf '\nRELEASE CHECK PASS\n'
