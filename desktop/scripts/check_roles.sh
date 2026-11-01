#!/usr/bin/env bash
# End-to-end checks for remote roles (owner/admin/member), role-scoped provider
# access, library switching requests, expiry, and old remote.json compatibility.
#
# Usage: desktop/scripts/check_roles.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
PYTHON="$BACKEND/.venv/bin/python"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-roles.XXXXXX")"

SEED_PORT=47990
LOOP_PORT=47981
LAN_PORT=47982
FAKE_PORT=47983
FAKE_LAN_PORT=47984
LOOP="http://127.0.0.1:$LOOP_PORT"
LAN="http://127.0.0.1:$LAN_PORT"
FAKE="http://127.0.0.1:$FAKE_PORT"
FAKE_LAN="http://127.0.0.1:$FAKE_LAN_PORT"
LAN_ORIGIN="Origin: $LAN"
FAKE_ORIGIN="Origin: $FAKE_LAN"
LOOP_ORIGIN="Origin: $LOOP"
BACKEND_PID=""
FAKE_PID=""
GENERATION_PID=""

stop_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_pid "${GENERATION_PID:-}"
  stop_pid "${FAKE_PID:-}"
  stop_pid "${BACKEND_PID:-}"
  trash "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

say() { printf '  PASS %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for port in $SEED_PORT $LOOP_PORT $LAN_PORT $FAKE_PORT $FAKE_LAN_PORT; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $port is already in use by a process this script did not start"
  fi
done
[ -x "$PYTHON" ] || die "backend venv missing; run 'cd backend && uv sync'"
[ -f "$ROOT/frontend/dist/index.html" ] || die "frontend/dist missing; run 'cd frontend && npm run build'"

code() { curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' "$@"; }
expect() {
  [ "$3" = "$2" ] || {
    [ -f "$TMP/body" ] && head -c 600 "$TMP/body" >&2
    echo >&2
    die "$1: expected $2, got $3"
  }
  say "$1 -> $3"
}
jget() {
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."):
    if d is None:
        break
    d = d[int(key)] if isinstance(d, list) else d.get(key)
print("" if d is None else d)
PY
}
sid_for() {
  python3 - "$TMP/body" "$1" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1], encoding="utf-8"))["devices"]
print(next(d["id"] for d in devices if d["name"] == sys.argv[2]))
PY
}
wait_health() {
  local port="$1"
  local pid="$2"
  for _ in $(seq 1 150); do
    curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$port/api/health" && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
login() {
  local code="$1" jar="$2" name="$3" remember="$4" origin="$5" base="$6"
  code -c "$jar" -X POST -H "$origin" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$code\",\"name\":\"$name\",\"remember\":$remember}" \
    "$base/api/remote/login"
}
enable_request() {
  local base="$1" port="$2"
  printf '{"enabled":true,"port":%s}' "$port" >"$TMP/enable.json"
  code -X PUT -H 'Content-Type: application/json' \
    --data-binary "@$TMP/enable.json" "$base/api/remote/config"
}
switch_request() {
  local jar="$1" origin="$2" base="$3" id="$4" force="${5:-false}"
  printf '{"index":0,"id":"%s","force":%s}' "$id" "$force" >"$TMP/switch.json"
  code -b "$jar" -X POST -H "$origin" -H 'Content-Type: application/json' \
    --data-binary "@$TMP/switch.json" "$base/api/settings/library/switch"
}

head2 "seed two isolated libraries"
mkdir -p "$TMP/cfg"
DATA="$TMP/data"
RECENT="$TMP/recent"
(
  cd "$BACKEND"
  "$PYTHON" ../desktop/scripts/seed_synthetic.py --data-dir "$DATA" --images 2 --port "$SEED_PORT"
) >"$TMP/seed-current.json" 2>"$TMP/seed-current.log" || {
  cat "$TMP/seed-current.log" >&2
  die "could not seed current library"
}
(
  cd "$BACKEND"
  "$PYTHON" ../desktop/scripts/seed_synthetic.py --data-dir "$RECENT" --images 2 --port "$SEED_PORT"
) >"$TMP/seed-recent.json" 2>"$TMP/seed-recent.log" || {
  cat "$TMP/seed-recent.log" >&2
  die "could not seed recent library"
}
DATA_REAL="$("$PYTHON" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$DATA")"
RECENT_REAL="$("$PYTHON" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$RECENT")"
UI_JSON="$TMP/cfg/ui.json"
REMOTE_JSON="$TMP/cfg/remote.json"
"$PYTHON" - "$UI_JSON" "$RECENT_REAL" "$DATA_REAL" <<'PY'
import json, sys, time
path, recent, current = sys.argv[1:]
now = int(time.time())
with open(path, "w", encoding="utf-8") as fh:
    json.dump({
        "version": 1,
        "zoom": 1,
        "recent_libraries": [
            {"path": "relative/bad-record", "opened_at": now - 999},
            {"path": recent, "opened_at": now - 120},
            {"path": current, "opened_at": now},
        ],
    }, fh)
PY
SWITCH_ID="$("$PYTHON" -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' "$RECENT_REAL")"
say "current=$DATA_REAL recent=$RECENT_REAL id=$SWITCH_ID"

head2 "real desktop backend: member / admin"
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$DATA" IMAGEN_LIBRARY_MODE=existing IMAGEN_PORT="$LOOP_PORT" \
    IMAGEN_UI_PATH="$UI_JSON" IMAGEN_REMOTE_PATH="$REMOTE_JSON" \
    IMAGEN_INSTANCE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
    "$PYTHON" -m app.desktop
) >"$TMP/backend.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$LOOP_PORT" "$BACKEND_PID" || {
  cat "$TMP/backend.log" >&2
  die "backend did not become healthy"
}
expect "enable remote access" 200 "$(enable_request "$LOOP" "$LAN_PORT")"
ACCESS_CODE="$(jget "$TMP/body" code)"
[ -n "$ACCESS_CODE" ] || die "no access code"

MEMBER_JAR="$TMP/member.jar"
VISIT_JAR="$TMP/visit.jar"
expect "member login (remembered)" 200 "$(login "$ACCESS_CODE" "$MEMBER_JAR" "Role iPad" true "$LAN_ORIGIN" "$LAN")"
expect "member login (visit only)" 200 "$(login "$ACCESS_CODE" "$VISIT_JAR" "Visit iPad" false "$LAN_ORIGIN" "$LAN")"
expect "member /api/session" 200 "$(code -b "$MEMBER_JAR" "$LAN/api/session")"
[ "$(jget "$TMP/body" role)" = "member" ] || die "member session role is not member"
SESSION_KEY="$(jget "$TMP/body" library_key)"
[ -n "$SESSION_KEY" ] || die "/api/session did not include library_key"
expect "member Gemini write denied" 403 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"key":"fake-rbac-key-1234"}' "$LAN/api/providers/gemini/key")"
expect "member Vertex write denied" 403 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"project":"fake-rbac-project","location":"global"}' "$LAN/api/settings/vertex")"
expect "member library switch denied" 403 "$(switch_request "$MEMBER_JAR" "$LAN_ORIGIN" "$LAN" "$SWITCH_ID")"

expect "loopback status" 200 "$(code "$LOOP/api/remote/status")"
MEMBER_SID="$(sid_for "Role iPad")"
VISIT_SID="$(sid_for "Visit iPad")"
[ "$(python3 - "$TMP/body" "$VISIT_SID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(next(x["remember"] for x in d["devices"] if x["id"] == sys.argv[2]))
PY
)" = "False" ] || die "visit session remember=false was not persisted"
expect "unremembered session cannot become admin" 409 "$(code -X PUT \
  -H 'Content-Type: application/json' -d '{"role":"admin"}' \
  "$LOOP/api/remote/sessions/$VISIT_SID/role")"
[ "$(jget "$TMP/body" detail)" = "not_remembered" ] || die "wrong not_remembered response"
expect "promote remembered session" 200 "$(code -X PUT \
  -H 'Content-Type: application/json' -d '{"role":"admin"}' \
  "$LOOP/api/remote/sessions/$MEMBER_SID/role")"
[ "$(jget "$TMP/body" devices.0.role)" = "admin" ] || die "role not returned in status"

curl -sS -D "$TMP/admin.headers" -o "$TMP/body" -b "$MEMBER_JAR" "$LAN/api/session"
grep -q '"role":"admin"' "$TMP/body" || grep -q '"role": "admin"' "$TMP/body" \
  || die "admin /api/session did not report admin"
SETCOOKIE="$(grep -i '^set-cookie:' "$TMP/admin.headers" || true)"
printf '%s' "$SETCOOKIE" | grep -qi 'Max-Age=7776000' \
  || die "admin cookie was not refreshed for 90 days: $SETCOOKIE"
say "admin cookie refreshed with Max-Age=7776000"
curl -sS -D "$TMP/admin2.headers" -o /dev/null -b "$MEMBER_JAR" "$LAN/api/session"
if grep -qi '^set-cookie:' "$TMP/admin2.headers"; then
  die "admin cookie refreshed twice on the same day"
fi
say "no second cookie refresh on the same day"

expect "admin Gemini key write" 200 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"key":"fake-rbac-key-1234"}' "$LAN/api/providers/gemini/key")"
expect "admin Vertex write" 200 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"project":"fake-rbac-project","location":"global"}' "$LAN/api/settings/vertex")"
expect "admin provider toggle" 200 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' "$LAN/api/providers/gemini")"
expect "admin provider catalog" 200 "$(code -b "$MEMBER_JAR" "$LAN/api/providers")"
grep -q 'fake-rbac-project' "$TMP/body" || die "admin catalog hid the Vertex project"
grep -q 'keyLast4' "$TMP/body" || die "admin catalog hid the Gemini key tail"
expect "admin check reaches provider" 200 "$(code -b "$MEMBER_JAR" -X POST -H "$LAN_ORIGIN" "$LAN/api/providers/vertex/check")"
say "admin sees owner-style provider detail and can run checks"

expect "LAN remote status still hidden" 404 "$(code -b "$MEMBER_JAR" "$LAN/api/remote/status")"
expect "LAN remote config still hidden" 404 "$(code -b "$MEMBER_JAR" -X PUT -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' "$LAN/api/remote/config")"
expect "LAN remote session management still hidden" 404 "$(code -b "$MEMBER_JAR" -X DELETE \
  -H "$LAN_ORIGIN" "$LAN/api/remote/sessions")"
expect "LAN desktop bridge still hidden" 404 "$(code -b "$MEMBER_JAR" "$LAN/api/desktop/wait?since=0&timeout=0")"

expect "admin library info" 200 "$(code -b "$MEMBER_JAR" "$LAN/api/settings/library")"
[ "$(jget "$TMP/body" path)" = "" ] || die "admin library path is not empty"
[ "$(jget "$TMP/body" recent.0.id)" = "$SWITCH_ID" ] || die "admin recent id mismatch"
[ "$(jget "$TMP/body" key)" = "$SESSION_KEY" ] || die "session/library keys disagree"
python3 - "$TMP/body" "$DATA_REAL" "$RECENT_REAL" <<'PY' || die "admin library response leaked a path"
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
d = json.loads(raw)
if "path" in d["recent"][0]:
    raise SystemExit("recent item has a path key")
for path in sys.argv[2:]:
    if path in raw:
        raise SystemExit(f"library path leaked: {path}")
PY
say "LAN admin library info has opaque recents and no paths"
expect "owner switch endpoint stays shell-only" 404 "$(switch_request "$MEMBER_JAR" "$LOOP_ORIGIN" "$LOOP" "$SWITCH_ID")"

head2 "library switch request lifecycle"
expect "wrong recent id" 409 "$(code -b "$MEMBER_JAR" -X POST -H "$LAN_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"index":0,"id":"0000000000000000"}' \
  "$LAN/api/settings/library/switch")"
[ "$(jget "$TMP/body" detail)" = "library_changed" ] || die "wrong id did not return library_changed"
expect "queue switch" 202 "$(switch_request "$MEMBER_JAR" "$LAN_ORIGIN" "$LAN" "$SWITCH_ID")"
expect "snapshot exposes request" 200 "$(code "$LOOP/api/desktop/wait?since=0&timeout=0")"
REQUEST_ID="$(jget "$TMP/body" library_request.id)"
[ -n "$REQUEST_ID" ] || die "library_request missing from desktop snapshot"
[ "$(jget "$TMP/body" library_request.by)" = "Role iPad" ] || die "request device name mismatch"
expect "wrong ack id" 404 "$(code -X POST "$LOOP/api/desktop/library-request/not-$REQUEST_ID/ack")"
expect "ack switch request" 200 "$(code -X POST "$LOOP/api/desktop/library-request/$REQUEST_ID/ack")"
expect "snapshot clears request" 200 "$(code "$LOOP/api/desktop/wait?since=0&timeout=0")"
[ -z "$(jget "$TMP/body" library_request.id)" ] || die "request survived ack"
expect "queue second switch" 202 "$(switch_request "$MEMBER_JAR" "$LAN_ORIGIN" "$LAN" "$SWITCH_ID")"
expect "second pending switch rejected" 409 "$(switch_request "$MEMBER_JAR" "$LAN_ORIGIN" "$LAN" "$SWITCH_ID")"
[ "$(jget "$TMP/body" detail)" = "switch_pending" ] || die "pending switch detail mismatch"
code -X POST "$LOOP/api/desktop/wait?since=0&timeout=0" >/dev/null
PENDING_ID="$(jget "$TMP/body" library_request.id)"
code -X POST "$LOOP/api/desktop/library-request/$PENDING_ID/ack" >/dev/null

head2 "immediate downgrade"
expect "demote to member" 200 "$(code -X PUT -H 'Content-Type: application/json' \
  -d '{"role":"member"}' "$LOOP/api/remote/sessions/$MEMBER_SID/role")"
expect "demoted next request is member" 200 "$(code -b "$MEMBER_JAR" "$LAN/api/session")"
[ "$(jget "$TMP/body" role)" = "member" ] || die "downgrade did not take effect"
expect "demoted provider write immediately denied" 403 "$(code -b "$MEMBER_JAR" -X PUT \
  -H "$LAN_ORIGIN" -H 'Content-Type: application/json' -d '{"key":"fake-rbac-key-5678"}' \
  "$LAN/api/providers/gemini/key")"
expect "re-promote for expiry test" 200 "$(code -X PUT -H 'Content-Type: application/json' \
  -d '{"role":"admin"}' "$LOOP/api/remote/sessions/$MEMBER_SID/role")"

head2 "busy switch check (fake backend)"
FDATA="$TMP/fake-data"
FRECENT="$TMP/fake-recent"
for i in 1 2; do
  dir="$FDATA"
  [ "$i" = 2 ] && dir="$FRECENT"
  (
    cd "$BACKEND"
    "$PYTHON" ../desktop/scripts/seed_synthetic.py --data-dir "$dir" --images 1 --port "$SEED_PORT"
  ) >/dev/null 2>"$TMP/fake-seed-$i.log" || {
    cat "$TMP/fake-seed-$i.log" >&2
    die "fake-library seed $i failed"
  }
done
FDATA_REAL="$("$PYTHON" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$FDATA")"
FRECENT_REAL="$("$PYTHON" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$FRECENT")"
FUI="$TMP/cfg/fake-ui.json"
FREMOTE="$TMP/cfg/fake-remote.json"
"$PYTHON" - "$FUI" "$FRECENT_REAL" "$FDATA_REAL" <<'PY'
import json, sys, time
path, recent, current = sys.argv[1:]
now = int(time.time())
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"version": 1, "zoom": 1, "recent_libraries": [
        {"path": recent, "opened_at": now - 90},
        {"path": current, "opened_at": now},
    ]}, fh)
PY
FSWITCH_ID="$("$PYTHON" -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' "$FRECENT_REAL")"
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$FDATA" IMAGEN_LIBRARY_MODE=auto IMAGEN_PORT="$FAKE_PORT" \
    IMAGEN_UI_PATH="$FUI" IMAGEN_REMOTE_PATH="$FREMOTE" IMAGEN_LOG_DIR="$TMP/fake-logs" \
    FAKE_DELAY_S=8 FAKE_OUTCOME=success "$PYTHON" ../desktop/scripts/fake_backend.py
) >"$TMP/fake.log" 2>&1 &
FAKE_PID=$!
disown "$FAKE_PID" 2>/dev/null || true
wait_health "$FAKE_PORT" "$FAKE_PID" || {
  cat "$TMP/fake.log" >&2
  die "fake backend did not become healthy"
}
expect "fake enable remote access" 200 "$(enable_request "$FAKE" "$FAKE_LAN_PORT")"
FCODE="$(jget "$TMP/body" code)"
FJAR="$TMP/fake.jar"
expect "fake admin login" 200 "$(login "$FCODE" "$FJAR" "Fake Admin iPad" true "$FAKE_ORIGIN" "$FAKE_LAN")"
code "$FAKE/api/remote/status" >/dev/null
FSID="$(sid_for "Fake Admin iPad")"
expect "fake promote admin" 200 "$(code -X PUT -H 'Content-Type: application/json' \
  -d '{"role":"admin"}' "$FAKE/api/remote/sessions/$FSID/role")"
expect "fake enable Gemini" 200 "$(code -b "$FJAR" -X PUT -H "$FAKE_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' "$FAKE_LAN/api/providers/gemini")"
expect "fake queue report" 200 "$(code -X PUT -H 'Content-Type: application/json' \
  -d '{"queued":2,"running":0,"lang":"en"}' "$FAKE/api/desktop/client")"
GEN_BODY='{"prompt":"rbac busy check","provider":"gemini","model":"gemini-3-pro-image","aspectRatio":"1:1","resolution":null,"outputFormat":"image/png","inputImageIds":[],"uploadImageIds":[],"clientTaskId":"rbac-busy"}'
(
  curl -sS --max-time 40 -b "$FJAR" -H "$FAKE_ORIGIN" -H 'Content-Type: application/json' \
    -d "$GEN_BODY" "$FAKE_LAN/api/generate" >"$TMP/fake-generate.json"
) &
GENERATION_PID=$!
disown "$GENERATION_PID" 2>/dev/null || true
for _ in $(seq 1 80); do
  code "$FAKE/api/desktop/activity" >/dev/null
  [ "$(jget "$TMP/body" generating)" = "1" ] && break
  sleep 0.1
done
[ "$(jget "$TMP/body" generating)" = "1" ] || die "fake generation did not enter the running count"
expect "busy switch" 409 "$(switch_request "$FJAR" "$FAKE_ORIGIN" "$FAKE_LAN" "$FSWITCH_ID")"
[ "$(jget "$TMP/body" detail)" = "busy" ] || die "busy switch detail mismatch"
[ "$(jget "$TMP/body" running)" = "1" ] || die "busy running count mismatch"
[ "$(jget "$TMP/body" queued_mac)" = "2" ] || die "busy queued_mac mismatch"
python3 - "$TMP/body" <<'PY' || die "busy running_by omitted the admin device"
import json, sys
d = json.load(open(sys.argv[1]))
rows = d["running_by"]
if not any(r["device"] == "Fake Admin iPad" and r["n"] == 1 for r in rows):
    raise SystemExit(rows)
PY
say "busy switch reports device/running/queued counts"
expect "force switch" 202 "$(switch_request "$FJAR" "$FAKE_ORIGIN" "$FAKE_LAN" "$FSWITCH_ID" true)"
stop_pid "$GENERATION_PID"
GENERATION_PID=""
stop_pid "$FAKE_PID"
FAKE_PID=""

head2 "admin idle expiry; member 30-day rule unchanged"
stop_pid "$BACKEND_PID"
BACKEND_PID=""
"$PYTHON" - "$REMOTE_JSON" "$MEMBER_SID" <<'PY'
import json, sys, time
path, sid = sys.argv[1:]
d = json.load(open(path, encoding="utf-8"))
for session in d["sessions"]:
    if session["id"] == sid:
        session["last_seen"] = time.time() - 91 * 24 * 3600
with open(path, "w", encoding="utf-8") as fh:
    json.dump(d, fh)
PY
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$DATA" IMAGEN_LIBRARY_MODE=existing IMAGEN_PORT="$LOOP_PORT" \
    IMAGEN_UI_PATH="$UI_JSON" IMAGEN_REMOTE_PATH="$REMOTE_JSON" \
    "$PYTHON" -m app.desktop
) >"$TMP/backend2.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$LOOP_PORT" "$BACKEND_PID" || {
  cat "$TMP/backend2.log" >&2
  die "backend did not restart"
}
for _ in $(seq 1 50); do
  lsof -nP -iTCP:"$LAN_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.1
done
expect "91-day-idle admin rejected" 401 "$(code -b "$MEMBER_JAR" "$LAN/api/images")"
expect "30-day member session still valid" 200 "$(code -b "$VISIT_JAR" "$LAN/api/images")"

head2 "legacy remote.json defaults"
OLD="$TMP/old/remote.json"
mkdir -p "$TMP/old"
"$PYTHON" - "$OLD" <<'PY'
import hashlib, json, sys, time
sid = hashlib.sha256(b"legacy-token").hexdigest()
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump({"version": 1, "enabled": False, "port": 47861, "require_code": True,
               "code": "12345", "keep_awake": True,
               "sessions": [{"id": sid, "name": "Legacy", "created_at": time.time(),
                             "last_seen": time.time(), "last_ip": "127.0.0.1", "ua": ""}]}, fh)
PY
(
  cd "$BACKEND"
  env -u IMAGEN_LIBRARY_MODE IMAGEN_REMOTE_PATH="$OLD" "$PYTHON" - <<'PY'
from app import remote
session = remote.find_session("legacy-token")
assert session is not None, session
assert session["role"] == "member", session
assert session["remember"] is True, session
assert session["role_since"] is None, session
print("  PASS old remote.json defaults role=member remember=true")
PY
)

head2 "session persistence and member expiry reset"
UNIT_REMOTE="$TMP/session-unit/remote.json"
mkdir -p "$TMP/session-unit"
(
  cd "$BACKEND"
  env -u IMAGEN_LIBRARY_MODE IMAGEN_REMOTE_PATH="$UNIT_REMOTE" "$PYTHON" - <<'PY'
import json
import time

from app import remote

token = remote.create_session("Demote test", "127.0.0.1", "", remember=True)
sid = remote._hash(token)
session = remote.find_session(token)
session["role"] = "admin"
session["role_since"] = time.time() - 60 * 24 * 3600
session["created_at"] = time.time() - 60 * 24 * 3600
session["_cookie_refreshed"] = time.monotonic()
remote._save()

with open(remote._path(), encoding="utf-8") as fh:
    persisted = json.load(fh)["sessions"][0]
assert not any(key.startswith("_") for key in persisted), persisted

before = time.time()
public = remote.set_role(sid, "member")
after = remote.find_session(token)
assert public["role"] == "member"
assert not any(key.startswith("_") for key in public), public
assert after["created_at"] >= before - 1, after
assert after["role"] == "member"
print("  PASS internal session keys are not persisted; demotion resets the member clock")
PY
)

printf '\nROLES CHECK PASS\n'
