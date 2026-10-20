#!/usr/bin/env bash
# End-to-end checks for the keep-alive /api/generate stream.
#
# Uses desktop/scripts/fake_backend.py and a synthetic seed directory. The
# default delay is 70 s (longer than WebKit's ~61 s idle timeout); --quick uses
# 5 s for a fast local loop. All processes are cleaned up by PID only.
#
# Usage: desktop/scripts/check_generate_stream.sh [--quick]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
PYTHON="$BACKEND/.venv/bin/python"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-stream.XXXXXX")"
DATA="$TMP/data"
LOGS="$TMP/logs"
PORT=47931
DELAY=70
BACKEND_PID=""

case "${1:-}" in
  "") ;;
  --quick) DELAY=5 ;;
  *) echo "usage: $0 [--quick]" >&2; exit 2 ;;
esac

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

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already in use by a process this script did not start"
fi

[ -x "$PYTHON" ] || die "backend venv missing; run 'cd backend && uv sync'"
[ -f "$ROOT/desktop/scripts/seed_synthetic.py" ] || die "seed script missing"
[ -f "$ROOT/desktop/scripts/fake_backend.py" ] || die "fake backend missing"

mkdir -p "$LOGS"
echo "==> seed (2 synthetic images, port $PORT)"
(
  cd "$BACKEND"
  "$PYTHON" ../desktop/scripts/seed_synthetic.py \
    --data-dir "$DATA" --images 2 --port "$PORT"
) >"$TMP/seed.json" 2>"$TMP/seed.log" || { cat "$TMP/seed.log" >&2; die "seed failed"; }
echo "seed ok: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["images"]["uploaded"], "uploaded /", d["images"]["live_after_seed"], "live")' "$TMP/seed.json")"

TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
echo "==> fake backend (delay ${DELAY}s, port $PORT)"
(
  cd "$BACKEND"
  exec env \
    IMAGEN_DATA_DIR="$DATA" \
    IMAGEN_PORT="$PORT" \
    IMAGEN_INSTANCE_TOKEN="$TOKEN" \
    IMAGEN_LOG_DIR="$LOGS" \
    FAKE_DELAY_S="$DELAY" \
    FAKE_OUTCOME=success \
    "$PYTHON" ../desktop/scripts/fake_backend.py
) >"$TMP/fake.log" 2>&1 &
BACKEND_PID=$!
# Keep the shell from printing "Terminated" when cleanup stops this job.
disown "$BACKEND_PID" 2>/dev/null || true

for _ in $(seq 1 200); do
  if curl -sf --max-time 1 -o "$TMP/health.json" "http://127.0.0.1:$PORT/api/health"; then
    if python3 - "$TMP/health.json" "$TOKEN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    d = json.load(fh)
raise SystemExit(0 if d.get("app") == "imagen" and d.get("token") == sys.argv[2] else 1)
PY
    then
      break
    fi
  fi
  kill -0 "$BACKEND_PID" 2>/dev/null || { cat "$TMP/fake.log" >&2; die "fake backend exited"; }
  sleep 0.1
done

if ! curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  cat "$TMP/fake.log" >&2
  die "fake backend did not become healthy"
fi
echo "health ok"

"$PYTHON" - "$PORT" "$DELAY" <<'PY'
import json
import sys
import time

import httpx

port = int(sys.argv[1])
delay = float(sys.argv[2])
base = f"http://127.0.0.1:{port}"
timeout = delay + 60


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def generation_for(client: httpx.Client, cid: str):
    body = client.get("/api/generations", params={"limit": 200}).json()
    return next((g for g in body["generations"] if g.get("client_task_id") == cid), None)


def payload(cid: str) -> dict:
    return {
        "prompt": "stream check",
        "model": "gemini-3-pro-image",
        "aspectRatio": "1:1",
        "resolution": None,
        "outputFormat": "image/png",
        "inputImageIds": [],
        "uploadImageIds": [],
        "clientTaskId": cid,
    }


# --- a. long request + TTFB + keep-alive chunks ---------------------------
cid = f"stream-long-{time.time_ns()}"
started = time.monotonic()
chunks = []
body = b""
with httpx.Client(base_url=base, timeout=timeout) as client:
    with client.stream("POST", "/api/generate", json=payload(cid)) as response:
        if response.status_code != 200:
            fail(f"long: HTTP {response.status_code}")
        first = True
        for chunk in response.iter_raw():
            now = time.monotonic() - started
            if first:
                ttfb = now
                first = False
            chunks.append(now)
            body += chunk
        total = time.monotonic() - started
    result = json.loads(body)
    row = generation_for(client, cid)

ttfb = chunks[0]
if ttfb > 3.0:
    fail(f"long: first byte took {ttfb:.3f}s")
if total < delay - 1.5:
    fail(f"long: finished in {total:.3f}s, expected ~{delay:.0f}s")
if delay >= 60 and len(chunks) < 4:
    fail(f"long: only {len(chunks)} response chunks; keep-alive spaces are missing")
if result.get("status") != "success":
    fail(f"long: status={result.get('status')} message={result.get('message')}")
if not result.get("outputImage") or not row or row.get("status") != "success":
    fail("long: success result was not persisted")
print(
    f"PASS long: http=200 ttfb={ttfb:.4f}s total={total:.3f}s "
    f"chunks={len(chunks)} status=success image={result['outputImage']['id']}"
)

# --- b. client disconnect -------------------------------------------------
cid = f"stream-disconnect-{time.time_ns()}"
httpx.post(f"{base}/__test/fake-reset", timeout=5)
with httpx.Client(base_url=base, timeout=timeout) as client:
    with client.stream("POST", "/api/generate", json=payload(cid)) as response:
        iterator = response.iter_raw()
        next(iterator)  # headers + first keep-alive byte, generation has started
    # Leaving the context closes the connection without reading the result.
    deadline = time.monotonic() + delay + 30
    row = None
    while time.monotonic() < deadline:
        row = generation_for(client, cid)
        if row and row.get("status") != "running":
            break
        time.sleep(0.5)
    state = client.get("/__test/fake-state", timeout=5).json()

if not row:
    fail("disconnect: generation row disappeared")
if row.get("status") != "error" or row.get("raw_finish") != "CLIENT_DISCONNECTED":
    fail(
        "disconnect: expected error/CLIENT_DISCONNECTED, got "
        f"{row.get('status')}/{row.get('raw_finish')} after {row.get('error_message')}"
    )
if not state.get("abort_seen"):
    fail("disconnect: fake backend never observed should_abort")
print(
    "PASS disconnect: curl-equivalent stream closed after first byte; "
    f"row=error raw_finish=CLIENT_DISCONNECTED abort_seen=true observations={state['count']}"
)

# --- c. explicit cancel ---------------------------------------------------
cid = f"stream-cancel-{time.time_ns()}"
httpx.post(f"{base}/__test/fake-reset", timeout=5)
holder: dict = {}


def run_cancel_request() -> None:
    try:
        with httpx.Client(base_url=base, timeout=timeout) as client:
            with client.stream("POST", "/api/generate", json=payload(cid)) as response:
                text = b"".join(response.iter_raw())
                holder["http"] = response.status_code
                holder["body"] = text
    except Exception as exc:  # noqa: BLE001
        holder["error"] = str(exc)


import threading

thread = threading.Thread(target=run_cancel_request, daemon=True)
thread.start()

# Wait until the request is in flight (the fake emits a "sent" event).
for _ in range(100):
    progress = httpx.get(f"{base}/api/generate/progress/{cid}", timeout=5).json()
    if progress.get("phase") not in (None, "unknown"):
        break
    time.sleep(0.1)
else:
    fail("cancel: request never became in-flight")

cancel = httpx.post(f"{base}/api/generate/cancel/{cid}", timeout=5)
if cancel.status_code != 200 or cancel.json() != {"ok": True}:
    fail(f"cancel: endpoint returned {cancel.status_code} {cancel.text[:200]}")
thread.join(timeout=delay + 30)
if thread.is_alive():
    fail("cancel: request did not finish")
if "error" in holder:
    fail(f"cancel: request error {holder['error']}")
result = json.loads(holder["body"])
if result.get("status") != "aborted":
    fail(f"cancel: status={result.get('status')} message={result.get('message')}")
with httpx.Client(base_url=base, timeout=10) as client:
    remaining = generation_for(client, cid)
    state = client.get("/__test/fake-state", timeout=5).json()
if remaining is not None:
    fail("cancel: generation row was not deleted")
if not state.get("abort_seen"):
    fail("cancel: fake backend never observed should_abort")
print(
    "PASS cancel: {\"ok\":true}; final status=aborted; row deleted; "
    f"abort_seen=true observations={state['count']}"
)

# --- d. no Vertex project -> plain 400 JSON -------------------------------
with httpx.Client(base_url=base, timeout=10) as client:
    client.put("/api/settings/vertex", json={"project": "", "location": "global"}).raise_for_status()
    response = client.post("/api/generate", json=payload(f"stream-noproject-{time.time_ns()}"))
    if response.status_code != 400:
        fail(f"no-project: HTTP {response.status_code} {response.text[:200]}")
    if response.headers.get("content-type", "").split(";")[0] != "application/json":
        fail(f"no-project: content-type={response.headers.get('content-type')}")
    detail = response.json().get("detail", "")
    if "Vertex project not set" not in detail:
        fail(f"no-project: detail={detail!r}")
    client.put(
        "/api/settings/vertex",
        json={"project": "synthetic-not-a-project", "location": "global"},
    ).raise_for_status()
print(f'PASS no-project: http=400 json detail="{detail}"')

print(f"STREAM PASS (delay={delay:.0f}s)")
PY
