#!/usr/bin/env bash
# Checks for Docker/dev "server mode" (IMAGEN_ACCESS_CODE) and the plain
# Docker/dev gate (Host allowlist + cross-site writes).
#
# Runs the plain uvicorn backend against throwaway data directories; ports stay
# inside 47901-47999.
#
# Usage: desktop/scripts/check_server_auth.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
PYTHON="$BACKEND/.venv/bin/python"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-server.XXXXXX")"
PORT=47971
U="http://127.0.0.1:$PORT"
O="Origin: $U"
PID=""

stop() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  PID=""
}
cleanup() {
  stop
  trash "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

die() { echo "FAIL: $*" >&2; exit 1; }
say() { echo "  PASS $*"; }
code() { curl -s -o "$TMP/body" -w "%{http_code}" "$@"; }
expect() {
  [ "$3" = "$2" ] || die "$1: expected $2, got $3 ($(cat "$TMP/body" 2>/dev/null))"
  say "$1 -> $3"
}
start() {
  stop
  (cd "$BACKEND" && exec env "$@" IMAGEN_DATA_DIR="$TMP/data" \
    "$PYTHON" -m uvicorn app.main:app --port "$PORT" >"$TMP/server.log" 2>&1) &
  PID=$!
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$U/api/health" && return
    sleep 0.2
  done
  die "backend did not start: $(tail -5 "$TMP/server.log")"
}
login() {
  code -c "$2" -X POST -H "$O" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$1\",\"name\":\"check\"}" "$U/api/remote/login"
}

echo "== plain Docker/dev (no access code) =="
start IMAGEN_ALLOWED_HOSTS=imagen.lan
expect "IP host" 200 "$(code "$U/api/images")"
expect "localhost host" 200 "$(code -H "Host: localhost:$PORT" "$U/api/images")"
expect "allowlisted host" 200 "$(code -H 'Host: imagen.lan' "$U/api/images")"
expect "rebinding host" 403 "$(code -H 'Host: evil.example' "$U/api/images")"
expect "cross-site POST" 403 "$(code -X POST -H 'Origin: http://evil.example' "$U/api/images/bin/empty")"
expect "null-origin POST" 403 "$(code -X POST -H 'Origin: null' "$U/api/images/bin/empty")"
expect "Vite dev origin POST" 200 "$(code -X POST -H 'Origin: http://localhost:5173' "$U/api/images/bin/empty")"
expect "same-origin POST" 200 "$(code -X POST -H "$O" "$U/api/images/bin/empty")"
expect "no remote routes" 404 "$(code "$U/api/remote/hello")"

echo "== server mode: bad code refuses to start =="
if (cd "$BACKEND" && IMAGEN_ACCESS_CODE=12ab IMAGEN_DATA_DIR="$TMP/data" \
    "$PYTHON" -c "import app.main" >/dev/null 2>&1); then
  die "a non-5-digit code was accepted"
fi
say "non-5-digit code rejected"

echo "== server mode =="
start IMAGEN_ACCESS_CODE=24680
J="$TMP/jar"
expect "health is public" 200 "$(code "$U/api/health")"
expect "API needs a session" 401 "$(code "$U/api/images")"
expect "page redirects to /login" 302 "$(code "$U/")"
expect "/login is public" 200 "$(code "$U/login")"
expect "hello" 200 "$(code "$U/api/remote/hello")"
grep -q '"server":true' "$TMP/body" || die "hello does not report server mode"
expect "login without Origin" 403 "$(code -X POST -H 'Content-Type: application/json' -d '{"code":"24680"}' "$U/api/remote/login")"
expect "wrong code" 401 "$(login 11111 "$TMP/jar-bad")"
expect "right code" 200 "$(login 24680 "$J")"
expect "API with session" 200 "$(code -b "$J" "$U/api/images")"
expect "Vertex settings writable" 200 "$(code -b "$J" -X PUT -H "$O" -H 'Content-Type: application/json' -d '{"project":"bogus-check","location":"global"}' "$U/api/settings/vertex")"
expect "remote management hidden" 404 "$(code -b "$J" "$U/api/remote/status")"
expect "remote config hidden" 404 "$(code -b "$J" -X PUT -H "$O" -H 'Content-Type: application/json' -d '{"enabled":true}' "$U/api/remote/config")"
expect "cross-site POST with session" 403 "$(code -b "$J" -X POST -H 'Origin: http://evil.example' "$U/api/images/bin/empty")"
expect "logout" 200 "$(code -b "$J" -X POST -H "$O" "$U/api/remote/logout")"
expect "after logout" 401 "$(code -b "$J" "$U/api/images")"
for _ in 1 2 3 4 5; do login 11111 "$TMP/jar-bad" >/dev/null; done
expect "locked after 5 wrong codes" 429 "$(login 24680 "$TMP/jar-bad")"

echo "SERVER AUTH PASS"
