#!/usr/bin/env bash
# End-to-end checks for LAN remote access (backend only).
#
# Part A runs the real desktop backend (`python -m app.desktop`) against a
# throwaway library and drives the loopback config API + the LAN listener with
# curl. Part B uses desktop/scripts/fake_backend.py to prove a dropped LAN
# connection does not cancel a running generation. Everything lives under
# $TMPDIR; ports stay inside 47901-47999. The LAN listener is exercised via
# 127.0.0.1:<lan port>, which is the same listener a LAN device reaches.
#
# Usage: desktop/scripts/check_remote.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
PYTHON="$BACKEND/.venv/bin/python"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-remote.XXXXXX")"
LOOP_PORT=47951
LAN_PORT=47952
FAKE_PORT=47953
FAKE_LAN_PORT=47954
LOOP="http://127.0.0.1:$LOOP_PORT"
LAN="http://127.0.0.1:$LAN_PORT"
LAN_ORIGIN="Origin: $LAN"
BACKEND_PID=""

cleanup() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$BACKEND_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

say()   { printf '  PASS %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
die()   { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for p in $LOOP_PORT $LAN_PORT $FAKE_PORT $FAKE_LAN_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $p is already in use by a process this script did not start"
  fi
done
[ -x "$PYTHON" ] || die "backend venv missing; run 'cd backend && uv sync'"
[ -f "$ROOT/frontend/dist/index.html" ] || die "frontend/dist missing; run 'cd frontend && npm run build'"
command -v curl >/dev/null || die "curl not found"

code() { # curl args... -> http status
  curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' "$@"
}
expect() { # description want got
  [ "$3" = "$2" ] || { [ -f "$TMP/body" ] && head -c 400 "$TMP/body" >&2; echo >&2; die "$1: expected $2, got $3"; }
  say "$1 -> $3"
}
jget() { # file key (dotted)
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k)
print("" if d is None else d)
PY
}
put_config() { # json
  code -X PUT -H 'Content-Type: application/json' -d "$1" "$LOOP/api/remote/config"
}
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
login() { # code jar -> status
  code -c "$2" -X POST -H "$LAN_ORIGIN" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$1\",\"name\":\"Test iPad\",\"remember\":true}" "$LAN/api/remote/login"
}
lock_free() { # library dir -> 0 when this process can take the flock
  "$PYTHON" - "$1/.imagen.lock" <<'PY'
import fcntl
import sys

with open(sys.argv[1], "a+") as handle:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(1)
PY
}
wait_health() { # port
  for _ in $(seq 1 150); do
    curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$1/api/health" && return 0
    kill -0 "$BACKEND_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}

# --- A. real backend -------------------------------------------------------
head2 "A. real desktop backend (loopback $LOOP_PORT, LAN $LAN_PORT)"
DATA="$TMP/data"
REMOTE_JSON="$TMP/cfg/remote.json"
TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$DATA" IMAGEN_LIBRARY_MODE=create IMAGEN_PORT="$LOOP_PORT" \
    IMAGEN_REMOTE_PATH="$REMOTE_JSON" IMAGEN_INSTANCE_TOKEN="$TOKEN" \
    "$PYTHON" -m app.desktop
) >"$TMP/backend.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$LOOP_PORT" || { cat "$TMP/backend.log" >&2; die "backend did not become healthy"; }

listening "$LAN_PORT" && die "LAN port is listening before remote access was enabled"
say "remote access is off by default (LAN port closed)"
expect "loopback /api/remote/status" 200 "$(code "$LOOP/api/remote/status")"
[ "$(jget "$TMP/body" state)" = "off" ] || die "default state is not off"
[ "$(jget "$TMP/body" require_code)" = "True" ] || die "access code is not required by default"

# Loopback traffic must keep flowing while remote access is toggled.
( for _ in $(seq 1 60); do
    curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' "$LOOP/api/images"
    sleep 0.1
  done ) >"$TMP/loop-codes" &
POLL_PID=$!

ENABLE_JSON='{"enabled":true,"port":'"$LAN_PORT"'}'
expect "enable remote access" 200 "$(put_config "$ENABLE_JSON")"
[ "$(jget "$TMP/body" state)" != "off" ] || die "state still off after enabling"
CODE="$(jget "$TMP/body" code)"
python3 -c "import re,sys; sys.exit(0 if re.fullmatch(r'\d{5}', sys.argv[1]) else 1)" "$CODE" \
  || die "access code is not 5 digits: $CODE"
say "access code generated (5 digits)"
listening "$LAN_PORT" || die "LAN port not listening after enable"
expect "LAN GET /login reachable" 200 "$(code "$LAN/login")"
ADDRS="$(lsof -nP -a -p "$(lsof -nP -tiTCP:"$LAN_PORT" -sTCP:LISTEN | head -1)" -iTCP:"$LAN_PORT" -sTCP:LISTEN -Fn | sed -n 's/^n//p' | sort -u)"
[ "$ADDRS" = "*:$LAN_PORT" ] || die "LAN listener addresses: $ADDRS (expected *:$LAN_PORT, IPv4 only)"
say "LAN listener bound to IPv4 0.0.0.0 only"

# --- unauthenticated LAN ---
expect "LAN /api/images without session" 401 "$(code "$LAN/api/images")"
grep -q remote_auth_required "$TMP/body" || die "401 body lacks remote_auth_required"
LOCATION="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$LAN/")"
[ "$LOCATION" = "302 $LAN/login" ] || die "LAN / -> $LOCATION (expected 302 $LAN/login)"
say "LAN / -> 302 /login"
ASSET="$(ls "$ROOT/frontend/dist/assets" | head -1)"
expect "LAN /assets/$ASSET" 200 "$(code "$LAN/assets/$ASSET")"
expect "LAN /api/remote/hello" 200 "$(code "$LAN/api/remote/hello")"
expect "LAN /api/remote/status hidden (no session)" 401 "$(code "$LAN/api/remote/status")"

# --- login ---
JAR="$TMP/jar1"
expect "login with correct code" 200 "$(login "$CODE" "$JAR")"
grep -q imagen_remote "$JAR" || die "no session cookie set"
curl -s -D "$TMP/login.headers" -o /dev/null -X POST -H "$LAN_ORIGIN" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"Hdr\",\"remember\":true}" "$LAN/api/remote/login"
SETCOOKIE="$(grep -i '^set-cookie:' "$TMP/login.headers")"
for flag in HttpOnly 'SameSite=strict' 'Max-Age=2592000' 'Path=/'; do
  printf '%s' "$SETCOOKIE" | grep -qi "$flag" || die "Set-Cookie lacks $flag: $SETCOOKIE"
done
printf '%s' "$SETCOOKIE" | grep -qi 'Secure' && die "Set-Cookie must not carry Secure (plain HTTP)"
say "cookie: HttpOnly; SameSite=Strict; Max-Age=30d; no Secure"
expect "LAN /api/images with session" 200 "$(code -b "$JAR" "$LAN/api/images")"
expect "LAN /api/session is remote" 200 "$(code -b "$JAR" "$LAN/api/session")"
[ "$(jget "$TMP/body" remote)" = "True" ] || die "/api/session did not report remote=true"
[ "$(jget "$TMP/body" device.name)" = "Test iPad" ] || die "/api/session device name wrong"
expect "loopback /api/session is local" 200 "$(code "$LOOP/api/session")"
[ "$(jget "$TMP/body" remote)" = "False" ] || die "loopback /api/session reported remote"

# --- trimmed surface on the LAN ---
expect "LAN /api/remote/status" 404 "$(code -b "$JAR" "$LAN/api/remote/status")"
expect "LAN PUT /api/remote/config" 404 "$(code -b "$JAR" -X PUT -H "$LAN_ORIGIN" -H 'Content-Type: application/json' -d '{"enabled":false}' "$LAN/api/remote/config")"
expect "LAN PUT /api/settings/vertex" 403 "$(code -b "$JAR" -X PUT -H "$LAN_ORIGIN" -H 'Content-Type: application/json' -d '{"project":"x","location":"global"}' "$LAN/api/settings/vertex")"
expect "LAN /api/settings/library" 200 "$(code -b "$JAR" "$LAN/api/settings/library")"
python3 - "$TMP/body" "$DATA" <<'PY' || die "library info leaks the path"
import json, sys
d = json.load(open(sys.argv[1]))
raw = open(sys.argv[1]).read()
assert d["path"] == "" and d["recent"] == [] and d["desktop"] is False, d
assert sys.argv[2] not in raw
PY
say "library info on LAN has no path/recent"
expect "LAN /api/health" 200 "$(code -b "$JAR" "$LAN/api/health")"
[ -z "$(jget "$TMP/body" token)" ] || die "LAN /api/health exposes the instance token"
say "LAN /api/health has no token"
expect "loopback /api/health keeps token" 200 "$(code "$LOOP/api/health")"
[ "$(jget "$TMP/body" token)" = "$TOKEN" ] || die "loopback health lost its token"
expect "loopback /api/settings/library keeps path" 200 "$(code "$LOOP/api/settings/library")"
[ -n "$(jget "$TMP/body" path)" ] || die "loopback library path is empty"

# --- desktop shell bridge (loopback only) ---
expect "loopback PUT /api/desktop/client" 200 "$(code -X PUT -H 'Content-Type: application/json' -d '{"queued":2,"running":1,"lang":"en"}' "$LOOP/api/desktop/client")"
expect "loopback GET /api/desktop/activity" 200 "$(code "$LOOP/api/desktop/activity")"
[ "$(jget "$TMP/body" generating)" = "0" ] || die "activity.generating is not 0 before any generation"
[ "$(jget "$TMP/body" queued_local)" = "2" ] || die "activity.queued_local did not take the client report"
[ "$(jget "$TMP/body" lang)" = "en" ] || die "activity.lang did not take the client report"
expect "LAN PUT /api/desktop/client" 404 "$(code -b "$JAR" -X PUT -H "$LAN_ORIGIN" -H 'Content-Type: application/json' -d '{"queued":0,"running":0,"lang":"en"}' "$LAN/api/desktop/client")"
expect "LAN GET /api/desktop/activity" 404 "$(code -b "$JAR" "$LAN/api/desktop/activity")"
say "desktop bridge is loopback-only"

# --- host + origin checks ---
expect "loopback Host: evil.example" 403 "$(code -H 'Host: evil.example' "$LOOP/api/images")"
expect "loopback Host: 127.0.0.1 ok" 200 "$(code -H "Host: 127.0.0.1:$LOOP_PORT" "$LOOP/api/images")"
expect "loopback Host: localhost ok" 200 "$(code -H "Host: localhost:$LOOP_PORT" "$LOOP/api/images")"
expect "LAN POST without Origin" 403 "$(code -b "$JAR" -X POST -H 'Content-Type: application/json' -d '{"name":"t"}' "$LAN/api/tags")"
expect "LAN POST with foreign Origin" 403 "$(code -b "$JAR" -X POST -H 'Origin: http://evil.example' -H 'Content-Type: application/json' -d '{"name":"t"}' "$LAN/api/tags")"
expect "LAN POST with matching Origin" 200 "$(code -b "$JAR" -X POST -H "$LAN_ORIGIN" -H 'Content-Type: application/json' -d '{"name":"t"}' "$LAN/api/tags")"

# --- persistence ---
python3 - "$REMOTE_JSON" "$JAR" <<'PY' || die "remote.json check failed"
import json, os, stat, sys
path = sys.argv[1]
mode = stat.S_IMODE(os.stat(path).st_mode)
assert mode == 0o600, oct(mode)
raw = open(path).read()
d = json.loads(raw)
assert d["enabled"] and len(d["sessions"]) >= 1
token = [l.split("\t")[-1] for l in open(sys.argv[2]) if "imagen_remote" in l][0].strip()
assert token not in raw, "cookie token stored in plaintext"
assert all(len(s["id"]) == 64 for s in d["sessions"])
PY
say "remote.json is 0600 and stores only token hashes"

# --- status + device listing ---
expect "loopback status lists devices" 200 "$(code "$LOOP/api/remote/status")"
SID="$(jget "$TMP/body" devices.0.id)"
[ -n "$SID" ] || die "no device in status"

# --- revoke one session ---
JAR2="$TMP/jar2"
expect "second login" 200 "$(login "$CODE" "$JAR2")"
expect "second session works" 200 "$(code -b "$JAR2" "$LAN/api/images")"
expect "DELETE one session" 200 "$(code -X DELETE "$LOOP/api/remote/sessions/$SID")"
expect "revoked session rejected" 401 "$(code -b "$JAR" "$LAN/api/images")"
expect "other session unaffected" 200 "$(code -b "$JAR2" "$LAN/api/images")"

# --- new code signs everyone out ---
OLD_CODE="$CODE"
expect "regenerate code" 200 "$(code -X POST "$LOOP/api/remote/code/regenerate")"
CODE="$(jget "$TMP/body" code)"
[ "$CODE" != "$OLD_CODE" ] || say "(new code happened to equal the old one)"
expect "old cookie after new code" 401 "$(code -b "$JAR2" "$LAN/api/images")"
JAR3="$TMP/jar3"
expect "login with the new code" 200 "$(login "$CODE" "$JAR3")"

# --- access code off: open LAN, still guarded by Origin ---
expect "disable access code" 200 "$(put_config '{"require_code":false}')"
[ "$(jget "$TMP/body" state)" = "no_code" ] || die "state is not no_code"
expect "LAN /api/images with code off, no cookie" 200 "$(code "$LAN/api/images")"
expect "LAN POST without Origin with code off" 403 "$(code -X POST -H 'Content-Type: application/json' -d '{"name":"u"}' "$LAN/api/tags")"
expect "re-enable access code" 200 "$(put_config '{"require_code":true}')"
expect "LAN /api/images locked again" 401 "$(code "$LAN/api/images")"

# --- rate limit (last: it locks 127.0.0.1) ---
WRONG="$([ "$CODE" = "00000" ] && echo 11111 || echo 00000)"
for i in 1 2 3 4; do
  got="$(login "$WRONG" "$TMP/jar-bad")"
  [ "$got" = "401" ] || die "wrong code #$i: expected 401, got $got"
  [ "$(jget "$TMP/body" error)" = "wrong_code" ] || die "wrong code #$i: bad error body"
  [ "$(jget "$TMP/body" remaining)" = "$((5 - i))" ] || die "wrong code #$i: remaining=$(jget "$TMP/body" remaining)"
done
say "wrong codes 1-4 -> 401 with remaining"
expect "5th wrong code locks" 429 "$(login "$WRONG" "$TMP/jar-bad")"
RETRY="$(jget "$TMP/body" retry_after)"
[ "$(jget "$TMP/body" error)" = "locked" ] && [ "$RETRY" -gt 0 ] && [ "$RETRY" -le 61 ] || die "bad lock body (retry_after=$RETRY)"
say "lock reports retry_after=${RETRY}s"
expect "correct code while locked" 429 "$(login "$CODE" "$TMP/jar-bad")"
expect "status counts failures" 200 "$(code "$LOOP/api/remote/status")"
[ "$(jget "$TMP/body" failed_last_hour)" -ge 5 ] || die "failed_last_hour < 5"

# --- disable: LAN port closes, loopback never stopped ---
expect "disable remote access" 200 "$(put_config '{"enabled":false}')"
for _ in $(seq 1 30); do listening "$LAN_PORT" || break; sleep 0.1; done
listening "$LAN_PORT" && die "LAN port still listening after disable"
say "LAN port closed after disable"
wait "$POLL_PID"
BAD="$(grep -vc '^200$' "$TMP/loop-codes" || true)"
[ "$BAD" = "0" ] || { cat "$TMP/loop-codes" >&2; die "$BAD loopback requests failed while toggling"; }
say "all $(wc -l <"$TMP/loop-codes" | tr -d ' ') loopback requests succeeded while toggling"

# --- a quiet client's queue report ages out ---
sleep 21
expect "activity after the client went quiet" 200 "$(code "$LOOP/api/desktop/activity")"
[ "$(jget "$TMP/body" queued_local)" = "0" ] || die "queued_local is not 0 after the 20 s cutoff"
[ "$(jget "$TMP/body" lang)" = "en" ] || die "lang should survive the staleness cutoff"
say "queued_local falls back to 0 after the 20 s cutoff"

# --- config survives a restart ---
expect "enable again" 200 "$(put_config '{"enabled":true}')"
kill "$BACKEND_PID"; wait "$BACKEND_PID" 2>/dev/null || true
for _ in $(seq 1 30); do listening "$LAN_PORT" || break; sleep 0.1; done
listening "$LAN_PORT" && die "LAN port still listening after backend stop"
# SIGTERM shutdown is graceful: the flock can outlive the listener for a moment.
for _ in $(seq 1 100); do lock_free "$DATA" && break; sleep 0.1; done
lock_free "$DATA" || die "library lock still held after the backend stopped"
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$DATA" IMAGEN_LIBRARY_MODE=existing IMAGEN_PORT="$LOOP_PORT" \
    IMAGEN_REMOTE_PATH="$REMOTE_JSON" IMAGEN_INSTANCE_TOKEN="$TOKEN" \
    "$PYTHON" -m app.desktop
) >"$TMP/backend2.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$LOOP_PORT" || { cat "$TMP/backend2.log" >&2; die "backend did not restart"; }
for _ in $(seq 1 30); do listening "$LAN_PORT" && break; sleep 0.1; done
listening "$LAN_PORT" || die "LAN listener not restored after restart"
expect "session cookie survives restart" 200 "$(code -b "$JAR3" "$LAN/api/images")"
kill "$BACKEND_PID"; wait "$BACKEND_PID" 2>/dev/null || true
BACKEND_PID=""

# --- B. LAN disconnect must not cancel a generation -----------------------
head2 "B. LAN disconnect keeps the generation running (fake backend)"
FDATA="$TMP/fdata"
(
  cd "$BACKEND"
  "$PYTHON" ../desktop/scripts/seed_synthetic.py --data-dir "$FDATA" --images 2 --port "$FAKE_PORT"
) >"$TMP/seed.json" 2>"$TMP/seed.log" || { cat "$TMP/seed.log" >&2; die "seed failed"; }
(
  cd "$BACKEND"
  # fake_backend skips prepare_library; the mode var is what enables the
  # remote-access routes and gate, as in the real desktop entry point.
  exec env IMAGEN_DATA_DIR="$FDATA" IMAGEN_LIBRARY_MODE=auto IMAGEN_PORT="$FAKE_PORT" IMAGEN_LOG_DIR="$TMP/flogs" \
    IMAGEN_INSTANCE_TOKEN="$TOKEN" FAKE_DELAY_S=4 FAKE_OUTCOME=success \
    "$PYTHON" ../desktop/scripts/fake_backend.py
) >"$TMP/fake.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$FAKE_PORT" || { cat "$TMP/fake.log" >&2; die "fake backend did not become healthy"; }

"$PYTHON" - "$FAKE_PORT" "$FAKE_LAN_PORT" <<'PY'
import sys
import time

import httpx

loop_port, lan_port = int(sys.argv[1]), int(sys.argv[2])
loop = f"http://127.0.0.1:{loop_port}"
lan = f"http://127.0.0.1:{lan_port}"


def fail(msg):
    raise SystemExit(f"FAIL: {msg}")


r = httpx.put(f"{loop}/api/remote/config", json={"enabled": True, "port": lan_port, "require_code": False}, timeout=10)
if r.status_code != 200:
    fail(f"enable remote: {r.status_code} {r.text}")


def row_for(cid):
    gens = httpx.get(f"{loop}/api/generations", params={"limit": 200}, timeout=10).json()["generations"]
    return next((g for g in gens if g.get("client_task_id") == cid), None)


def run(base, headers, cid):
    httpx.post(f"{loop}/__test/fake-reset", timeout=5)
    body = {"prompt": "lan disconnect", "model": "gemini-3-pro-image", "aspectRatio": "1:1",
            "resolution": None, "outputFormat": "image/png", "inputImageIds": [],
            "uploadImageIds": [], "clientTaskId": cid}
    with httpx.Client(base_url=base, timeout=30, headers=headers) as c:
        with c.stream("POST", "/api/generate", json=body) as resp:
            if resp.status_code != 200:
                fail(f"{base}: HTTP {resp.status_code}")
            next(resp.iter_raw())  # generation started; now drop the connection
    deadline = time.monotonic() + 30
    row = None
    while time.monotonic() < deadline:
        row = row_for(cid)
        if row and row["status"] != "running":
            break
        time.sleep(0.3)
    state = httpx.get(f"{loop}/__test/fake-state", timeout=5).json()
    return row, state


row, state = run(lan, {"Origin": lan}, f"lan-drop-{time.time_ns()}")
if not row or row["status"] != "success":
    fail(f"LAN drop: expected success, got {row and (row['status'], row['raw_finish'])}")
if state.get("abort_seen"):
    fail("LAN drop: should_abort fired for a LAN disconnect")
print(f"  PASS LAN disconnect: generation finished status=success abort_seen=false")

# Control: the same drop on loopback still cancels cooperatively.
row, state = run(loop, {}, f"loop-drop-{time.time_ns()}")
if not row or row["raw_finish"] != "CLIENT_DISCONNECTED" or not state.get("abort_seen"):
    fail(f"loopback control: got {row and (row['status'], row['raw_finish'])} abort_seen={state.get('abort_seen')}")
print("  PASS loopback disconnect still aborts (control)")
PY

# --- C. /api/desktop/activity counts every generation lifecycle ------------
head2 "C. generation count returns to zero (fake backend)"
"$PYTHON" - "$FAKE_PORT" <<'PY'
import sys
import threading
import time

import httpx

loop = f"http://127.0.0.1:{int(sys.argv[1])}"


def fail(msg):
    raise SystemExit(f"FAIL: {msg}")


def activity():
    return httpx.get(f"{loop}/api/desktop/activity", timeout=10).json()


def wait_for(predicate, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = activity()
        if predicate(value):
            return value
        time.sleep(0.1)
    fail(f"timeout waiting for {what}; last activity={activity()}")


def config(outcome, delay):
    r = httpx.put(f"{loop}/__test/fake-config", json={"outcome": outcome, "delay": delay}, timeout=10)
    if r.status_code != 200:
        fail(f"fake-config: {r.status_code} {r.text}")


def start(cid, cancel=False):
    body = {
        "prompt": f"count {cid}",
        "model": "gemini-3-pro-image",
        "aspectRatio": "1:1",
        "resolution": None,
        "outputFormat": "image/png",
        "inputImageIds": [],
        "uploadImageIds": [],
        "clientTaskId": cid,
    }
    result = {}

    def worker():
        try:
            r = httpx.post(f"{loop}/api/generate", json=body, timeout=90)
            result["http"] = r.status_code
            result["status"] = (r.json() or {}).get("status")
        except Exception as exc:  # noqa: BLE001
            result["error"] = str(exc)

    thread = threading.Thread(target=worker)
    thread.start()
    seen = wait_for(lambda a: a["generating"] >= 1, 15, "the counter to reach 1")
    if seen["generating"] != 1:
        fail(f"generating should be exactly 1, got {seen['generating']}")
    if cancel:
        r = httpx.post(f"{loop}/api/generate/cancel/{cid}", timeout=10)
        if not r.json().get("ok"):
            fail(f"cancel was refused for {cid}")
    return thread, result


if activity()["generating"] != 0:
    fail("generating is not 0 at rest")

config("success", 1.5)
thread, result = start(f"count-ok-{time.time_ns()}")
thread.join(60)
if result.get("status") != "success":
    fail(f"success path: {result}")
wait_for(lambda a: a["generating"] == 0, 15, "the counter to fall back after success")
print("  PASS success: generating 1 -> 0, status=success")

config("error", 1.0)
thread, result = start(f"count-err-{time.time_ns()}")
thread.join(60)
if result.get("status") != "error":
    fail(f"error path: {result}")
wait_for(lambda a: a["generating"] == 0, 15, "the counter to fall back after an error")
print("  PASS error: generating 1 -> 0, status=error")

config("success", 10)
thread, result = start(f"count-cancel-{time.time_ns()}", cancel=True)
thread.join(60)
if result.get("status") != "aborted":
    fail(f"cancel path: {result}")
wait_for(lambda a: a["generating"] == 0, 15, "the counter to fall back after a cancel")
print("  PASS cancel: generating 1 -> 0, status=aborted")
config("success", 0)

# A 4xx validation failure never reaches the counter.
r = httpx.post(
    f"{loop}/api/generate",
    json={"prompt": "x", "model": "gemini-3-pro-image", "markerColor": "chartreuse"},
    timeout=10,
)
if r.status_code != 400:
    fail(f"validation failure: expected 400, got {r.status_code}")
time.sleep(0.3)
if activity()["generating"] != 0:
    fail("a 4xx validation failure was counted as an in-flight generation")
print("  PASS validation 4xx is not counted")
PY

printf '\nREMOTE CHECK PASS\n'
