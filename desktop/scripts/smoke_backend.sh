#!/usr/bin/env bash
# Backend smoke test for the desktop entry point.
#
# Runs against (1) the uv-managed virtualenv and, when present, (2) the
# PyInstaller onedir artifact. Everything happens in a throwaway data directory
# under $TMPDIR; ports stay inside the 47901-47999 test range.
#
# Usage: desktop/scripts/smoke_backend.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
FROZEN_DIR="$ROOT/desktop/src-tauri/resources/imagen-backend"
FROZEN_BIN="$FROZEN_DIR/imagen-backend"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-smoke.XXXXXX")"
UV_PORT=47911
FROZEN_PORT=47912

PIDS=()
cleanup() {
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  exec 9>&- 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

say()  { printf '  %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
die()  { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

get_code() { # url outfile
  curl -sS --max-time 30 -o "$2" -w '%{http_code}' "$1"
}

assert_json_key() { # file key
  python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
if sys.argv[2] not in data:
    raise SystemExit(f"missing key {sys.argv[2]!r} in {sorted(data)}")
PY
}

assert_port_free() { # port
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $1 is already in use by a process this script did not start"
  fi
}

wait_health() { # port token
  local port=$1 token=$2 body="$TMP/health-$1.json"
  for _ in $(seq 1 100); do
    if curl -sf --max-time 2 -o "$body" "http://127.0.0.1:$port/api/health"; then
      if python3 - "$body" "$token" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
raise SystemExit(0 if data.get("app") == "imagen" and data.get("token") == sys.argv[2] else 1)
PY
      then
        return 0
      fi
    fi
    sleep 0.2
  done
  return 1
}

listener_pid() { # port
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

listener_addresses() { # pid
  lsof -nP -a -p "$1" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u
}

run_instance() { # name port mode
  local name=$1 port=$2 mode=$3 token fifo log pid cwd
  token="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  fifo="$TMP/$name.stdin"
  log="$TMP/$name.log"
  mkfifo "$fifo"
  assert_port_free "$port"

  if [ "$mode" = "uv" ]; then
    cwd="$BACKEND"
    CMD=(uv run --frozen python -m app.desktop)
  else
    cwd="$TMP"
    CMD=("$FROZEN_BIN")
  fi

  ( cd "$cwd" && exec env \
      IMAGEN_DATA_DIR="$TMP/data-$name" \
      IMAGEN_PORT="$port" \
      IMAGEN_INSTANCE_TOKEN="$token" \
      IMAGEN_PARENT_WATCH=1 \
      "${CMD[@]}" ) <"$fifo" >"$log" 2>&1 &
  pid=$!
  # Keep the write end open so stdin stays alive; closing fd 9 later signals EOF.
  exec 9>"$fifo"

  wait_health "$port" "$token" || { cat "$log" >&2; die "[$name] backend did not become healthy"; }
  say "health ok (app=imagen, token matches)"

  local lpid
  lpid="$(listener_pid "$port")"
  [ -n "$lpid" ] || die "[$name] no listener on port $port"
  PIDS+=("$lpid")

  local addrs
  addrs="$(listener_addresses "$lpid")"
  [ "$addrs" = "127.0.0.1:$port" ] || die "[$name] listener addresses: ${addrs:-none} (expected 127.0.0.1:$port)"
  say "listening only on 127.0.0.1:$port"

  local code
  local dist_ok=1
  if [ "$mode" = "uv" ] && [ ! -f "$ROOT/frontend/dist/index.html" ]; then
    dist_ok=0
  fi
  if [ "$dist_ok" = 1 ]; then
    code="$(get_code "http://127.0.0.1:$port/" "$TMP/root.html")"
    [ "$code" = "200" ] || die "[$name] GET / -> $code"
    grep -qi '<div id="root"' "$TMP/root.html" || die "[$name] GET / did not return the SPA shell"
    say "GET / -> 200 (SPA shell)"
  else
    say "GET / skipped (frontend/dist not built)"
  fi

  local endpoint
  for endpoint in /api/images /api/drafts /api/generations /api/stats; do
    code="$(get_code "http://127.0.0.1:$port$endpoint" "$TMP/body.json")"
    [ "$code" = "200" ] || die "[$name] GET $endpoint -> $code"
    case "$endpoint" in
      /api/images) assert_json_key "$TMP/body.json" images ;;
      /api/drafts) assert_json_key "$TMP/body.json" drafts ;;
      /api/generations) assert_json_key "$TMP/body.json" generations ;;
      /api/stats) assert_json_key "$TMP/body.json" periods ;;
    esac
    say "GET $endpoint -> 200"
  done

  # Close the write end of the FIFO: the backend sees stdin EOF and must exit.
  exec 9>&-
  local waited=0
  while kill -0 "$lpid" 2>/dev/null; do
    if [ "$waited" -ge 50 ]; then
      die "[$name] backend still running 5s after stdin EOF"
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  say "exited $((waited * 100))ms after stdin EOF"

  # Re-open fd 9 for the next instance (kept by the trap).
  exec 9>/dev/null
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

# --- preflight ------------------------------------------------------------
head2 "preflight"
command -v curl >/dev/null || die "curl not found"
command -v lsof >/dev/null || die "lsof not found"
[ -f "$BACKEND/app/desktop.py" ] || die "backend/app/desktop.py missing"
say "repo: $ROOT"
say "temp data root: $TMP"

# --- refusal without IMAGEN_DATA_DIR -------------------------------------
head2 "refuses to start without IMAGEN_DATA_DIR"
for mode in uv frozen; do
  if [ "$mode" = "uv" ]; then
    [ -d "$BACKEND/.venv" ] || die "backend/.venv missing; run 'cd backend && uv sync'"
    NO_DIR_CMD=(uv run --frozen python -m app.desktop)
    NO_DIR_CWD="$BACKEND"
  else
    [ -x "$FROZEN_BIN" ] || { say "frozen artifact not found, skipping"; continue; }
    NO_DIR_CMD=("$FROZEN_BIN")
    NO_DIR_CWD="$TMP"
  fi
  set +e
  ( cd "$NO_DIR_CWD" && env -u IMAGEN_DATA_DIR -u IMAGEN_PARENT_WATCH \
      IMAGEN_PORT=47913 "${NO_DIR_CMD[@]}" ) </dev/null >"$TMP/nodir-$mode.log" 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || die "[$mode] started without IMAGEN_DATA_DIR (exit 0)"
  grep -q "IMAGEN_DATA_DIR" "$TMP/nodir-$mode.log" || die "[$mode] refusal message does not mention IMAGEN_DATA_DIR"
  say "[$mode] refused with exit $status: $(tail -1 "$TMP/nodir-$mode.log")"
done

# --- uv instance ----------------------------------------------------------
head2 "uv: python -m app.desktop (port $UV_PORT)"
run_instance uv "$UV_PORT" uv

# --- frozen instance ------------------------------------------------------
if [ -x "$FROZEN_BIN" ]; then
  head2 "PyInstaller: imagen-backend (port $FROZEN_PORT)"
  run_instance frozen "$FROZEN_PORT" frozen
else
  head2 "PyInstaller artifact not found"
  say "skipping frozen checks (run the PyInstaller build first)"
fi

printf '\nSMOKE PASS\n'
