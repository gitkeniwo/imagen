#!/usr/bin/env bash
# Checks for multi-provider support (Vertex AI + Gemini API), backend only.
#
# A. real desktop backend on a throwaway library: catalog shape, switches and
#    the last-provider 409, Gemini key PUT/DELETE (secrets.json, 0600, last 4
#    only, never in the library), generate validation, LAN read-only.
# B. plain uvicorn with IMAGEN_GEMINI_API_KEY: env key is read-only (409).
# C. migration: a library whose tables lack `provider` gains it as 'vertex'.
# D. fake_backend.py: Gemini/Vertex generations record their provider, JPG is
#    converted locally, drafts / manual history / stats carry the provider.
# E. unit test of the PNG -> JPG conversion.
#
# Nothing here calls Vertex or the Gemini API: keys are fake and generation
# goes through the fake backend. Everything lives under $TMPDIR; ports stay in
# 47961-47965; processes are stopped by PID only.
#
# Usage: desktop/scripts/check_providers.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
PYTHON="$BACKEND/.venv/bin/python"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/imagen-providers.XXXXXX")"
LOOP_PORT=47961
LAN_PORT=47962
ENV_PORT=47963
FAKE_PORT=47964
LOOP="http://127.0.0.1:$LOOP_PORT"
LAN="http://127.0.0.1:$LAN_PORT"
LAN_ORIGIN="Origin: $LAN"
FAKE_KEY="AIzaFAKE-providers-check-9fQ2"
BACKEND_PID=""

stop_backend() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$BACKEND_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  BACKEND_PID=""
}
cleanup() {
  stop_backend
  rm -rf "$TMP"
}
trap cleanup EXIT

say()   { printf '  PASS %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
die()   { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for p in $LOOP_PORT $LAN_PORT $ENV_PORT $FAKE_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $p is already in use by a process this script did not start"
  fi
done
[ -x "$PYTHON" ] || die "backend venv missing; run 'cd backend && uv sync'"
command -v curl >/dev/null || die "curl not found"

code() { # curl args... -> http status
  curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' "$@"
}
expect() { # description want got
  [ "$3" = "$2" ] || { [ -f "$TMP/body" ] && head -c 400 "$TMP/body" >&2; echo >&2; die "$1: expected $2, got $3"; }
  say "$1 -> $3"
}
detail_is() { # want
  python3 - "$TMP/body" "$1" <<'PY' || die "detail is not '$1': $(head -c 300 "$TMP/body")"
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8")).get("detail")
sys.exit(0 if d == sys.argv[2] or (isinstance(d, str) and sys.argv[2] in d) else 1)
PY
}
json_put() { # url json [extra curl args...]
  local url="$1" body="$2"; shift 2
  code -X PUT -H 'Content-Type: application/json' -d "$body" "$@" "$url"
}
gen() { # base json [extra curl args...] -> status (validation errors only)
  local base="$1" body="$2"; shift 2
  code -X POST -H 'Content-Type: application/json' -d "$body" "$@" "$base/api/generate"
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
CFG="$TMP/cfg"
SECRETS="$CFG/secrets.json"
(
  cd "$BACKEND"
  exec env -u IMAGEN_GEMINI_API_KEY IMAGEN_DATA_DIR="$DATA" IMAGEN_LIBRARY_MODE=create \
    IMAGEN_PORT="$LOOP_PORT" IMAGEN_REMOTE_PATH="$CFG/remote.json" IMAGEN_SECRETS_PATH="$SECRETS" \
    "$PYTHON" -m app.desktop
) >"$TMP/backend.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$LOOP_PORT" || { cat "$TMP/backend.log" >&2; die "backend did not become healthy"; }

expect "GET /api/providers" 200 "$(code "$LOOP/api/providers")"
python3 - "$TMP/body" <<'PY' || die "catalog shape"
import json, sys
d = json.load(open(sys.argv[1]))
ps = {p["id"]: p for p in d["providers"]}
assert list(ps) == ["vertex", "gemini"], list(ps)
v, g = ps["vertex"], ps["gemini"]
assert v["label"] == "Vertex AI" and g["label"] == "Gemini API"
assert v["enabled"] is True and g["enabled"] is False, (v["enabled"], g["enabled"])
assert v["configured"] is False and g["configured"] is False
assert v["detail"] == {"project": None, "location": "global"}, v["detail"]
assert g["detail"]["keySource"] is None and g["detail"]["keyLast4"] is None, g["detail"]
assert g["detail"]["keyStorage"] == "file", g["detail"]
for p in (v, g):
    ids = [m["id"] for m in p["models"]]
    assert ids == ["gemini-3-pro-image", "gemini-2.5-flash-image"], ids
    pro, flash = p["models"]
    assert pro["resolutions"] == ["1K", "2K", "4K"] and flash["resolutions"] == []
    assert len(pro["aspectRatios"]) == 10 and pro["aspectRatios"][0] == "1:1"
    assert pro["outputFormats"] == ["image/jpeg", "image/png"]
    for m in p["models"]:
        assert "wire_id" not in m and "wireId" not in m
assert v["models"][0]["transcodes"] == [] and g["models"][0]["transcodes"] == ["image/jpeg"]
PY
say "catalog: two providers, canonical models, defaults vertex on / gemini off"

# --- switches ---
expect "turn off the last provider" 409 "$(json_put "$LOOP/api/providers/vertex" '{"enabled":false}')"
detail_is last_provider
expect "unknown provider switch" 404 "$(json_put "$LOOP/api/providers/openai" '{"enabled":true}')"
expect "turn gemini on" 200 "$(json_put "$LOOP/api/providers/gemini" '{"enabled":true}')"
expect "turn vertex off (gemini still on)" 200 "$(json_put "$LOOP/api/providers/vertex" '{"enabled":false}')"
expect "turn gemini off (last one)" 409 "$(json_put "$LOOP/api/providers/gemini" '{"enabled":false}')"
detail_is last_provider
python3 - "$DATA/app.db" <<'PY' || die "switches not stored in settings"
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
rows = dict(c.execute("SELECT key, value FROM settings WHERE key LIKE 'provider_%'"))
assert rows == {"provider_gemini_enabled": "1", "provider_vertex_enabled": "0"}, rows
PY
say "switches persisted in the library settings table"

# --- generate validation (no upstream call can happen: every case is a 4xx) ---
GEN_GEMINI='{"prompt":"x","provider":"gemini","model":"gemini-3-pro-image","outputFormat":"image/jpeg"}'
GEN_VERTEX='{"prompt":"x","provider":"vertex","model":"gemini-3-pro-image","outputFormat":"image/jpeg"}'
expect "generate on a provider that is off" 400 "$(gen "$LOOP" "$GEN_VERTEX")"
detail_is "Vertex AI is turned off in Settings."
expect "generate with an unknown provider" 400 "$(gen "$LOOP" '{"prompt":"x","provider":"openai","model":"gemini-3-pro-image"}')"
expect "generate on Gemini without a key" 400 "$(gen "$LOOP" "$GEN_GEMINI")"
detail_is "Gemini API key not set. Add it in Settings › Providers."
expect "turn vertex back on" 200 "$(json_put "$LOOP/api/providers/vertex" '{"enabled":true}')"
expect "generate on Vertex without a project" 400 "$(gen "$LOOP" "$GEN_VERTEX")"
detail_is "Vertex project not set"
python3 - "$DATA/app.db" <<'PY' || die "a rejected request wrote a generation row"
import sqlite3, sys
n = sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM generations").fetchone()[0]
assert n == 0, n
PY
say "rejected requests wrote no history rows"

# --- Gemini key ---
expect "key: empty" 400 "$(json_put "$LOOP/api/providers/gemini/key" '{"key":"   "}')"
expect "key: inner whitespace" 400 "$(json_put "$LOOP/api/providers/gemini/key" '{"key":"abc def"}')"
LONG="$(python3 -c 'print("a" * 201)')"
expect "key: longer than 200" 400 "$(json_put "$LOOP/api/providers/gemini/key" "{\"key\":\"$LONG\"}")"
[ ! -e "$SECRETS" ] || die "secrets.json written by a rejected key"
expect "key: save" 200 "$(json_put "$LOOP/api/providers/gemini/key" "{\"key\":\"  $FAKE_KEY \"}")"
grep -q "$FAKE_KEY" "$TMP/body" && die "PUT response contains the full key"
expect "GET /api/providers after save" 200 "$(code "$LOOP/api/providers")"
grep -q "$FAKE_KEY" "$TMP/body" && die "GET /api/providers contains the full key"
python3 - "$TMP/body" <<'PY' || die "saved key status"
import json, sys
g = {p["id"]: p for p in json.load(open(sys.argv[1]))["providers"]}["gemini"]
assert g["configured"] is True, g
assert g["detail"]["keySource"] == "saved" and g["detail"]["keyLast4"] == "9fQ2", g["detail"]
PY
say "GET shows source=saved, last 4 only"
[ "$(stat -f '%Lp' "$SECRETS")" = "600" ] || die "secrets.json mode is $(stat -f '%Lp' "$SECRETS")"
python3 - "$SECRETS" "$FAKE_KEY" <<'PY' || die "secrets.json content"
import json, sys
d = json.load(open(sys.argv[1]))
assert d == {"version": 1, "gemini_api_key": sys.argv[2]}, d
PY
say "secrets.json: 0600, {version, gemini_api_key} (trimmed)"
ls -a "$CFG" | grep -q '^\.secrets-' && die "temporary secrets file left behind"
if grep -rqa "$FAKE_KEY" "$DATA"; then die "the key leaked into the library folder"; fi
say "key is not in the library folder (app.db, WAL, backups)"
expect "GET /api/settings/vertex unchanged" 200 "$(code "$LOOP/api/settings/vertex")"
expect "generate validation passes the key check" 400 "$(gen "$LOOP" '{"prompt":"x","provider":"gemini","model":"gemini-9-image","outputFormat":"image/jpeg"}')"
detail_is "is not available on Gemini API"
expect "generate rejects a format the model lacks" 400 "$(gen "$LOOP" '{"prompt":"x","provider":"gemini","model":"gemini-3-pro-image","outputFormat":"image/webp"}')"
detail_is "Unsupported output format"

# --- LAN: read-only ---
expect "enable remote access" 200 "$(json_put "$LOOP/api/remote/config" '{"enabled":true,"port":'"$LAN_PORT"',"require_code":false}')"
for _ in $(seq 1 50); do lsof -nP -iTCP:"$LAN_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.1; done
expect "LAN GET /api/providers" 200 "$(code "$LAN/api/providers")"
python3 - "$TMP/body" <<'PY' || die "LAN catalog leaks project/key tail"
import json, sys
ps = {p["id"]: p for p in json.load(open(sys.argv[1]))["providers"]}
assert "project" not in ps["vertex"]["detail"], ps["vertex"]["detail"]
assert "keyLast4" not in ps["gemini"]["detail"], ps["gemini"]["detail"]
assert ps["gemini"]["configured"] is True and ps["gemini"]["detail"]["keySource"] == "saved"
PY
say "LAN catalog has no project / keyLast4"
expect "LAN PUT switch" 403 "$(json_put "$LAN/api/providers/gemini" '{"enabled":false}' -H "$LAN_ORIGIN")"
expect "LAN PUT key" 403 "$(json_put "$LAN/api/providers/gemini/key" '{"key":"lan-key"}' -H "$LAN_ORIGIN")"
expect "LAN DELETE key" 403 "$(code -X DELETE -H "$LAN_ORIGIN" "$LAN/api/providers/gemini/key")"
expect "LAN POST check" 403 "$(code -X POST -H "$LAN_ORIGIN" "$LAN/api/providers/gemini/check")"
expect "disable remote access" 200 "$(json_put "$LOOP/api/remote/config" '{"enabled":false}')"

expect "key: delete" 200 "$(code -X DELETE "$LOOP/api/providers/gemini/key")"
python3 - "$TMP/body" "$SECRETS" <<'PY' || die "delete"
import json, sys
g = {p["id"]: p for p in json.load(open(sys.argv[1]))["providers"]}["gemini"]
assert g["configured"] is False and g["detail"]["keySource"] is None, g
assert "gemini_api_key" not in json.load(open(sys.argv[2]))
PY
say "deleted: not configured, file has no key"
expect "check without a key (no network)" 200 "$(code -X POST "$LOOP/api/providers/gemini/check")"
python3 - "$TMP/body" <<'PY' || die "check without key"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["ok"] is False and "not set" in d["message"], d
PY
if grep -qa "$FAKE_KEY" "$TMP/backend.log"; then die "the key appears in the backend log"; fi
say "key never logged"
stop_backend

# --- B. key from the environment -----------------------------------------
head2 "B. IMAGEN_GEMINI_API_KEY (uvicorn $ENV_PORT)"
(
  cd "$BACKEND"
  exec env IMAGEN_DATA_DIR="$TMP/envdata" IMAGEN_GEMINI_API_KEY="$FAKE_KEY" \
    "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$ENV_PORT"
) >"$TMP/env.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$ENV_PORT" || { cat "$TMP/env.log" >&2; die "env backend did not become healthy"; }
expect "GET /api/providers" 200 "$(code "http://127.0.0.1:$ENV_PORT/api/providers")"
grep -q "$FAKE_KEY" "$TMP/body" && die "GET contains the env key"
python3 - "$TMP/body" <<'PY' || die "env key status"
import json, sys
g = {p["id"]: p for p in json.load(open(sys.argv[1]))["providers"]}["gemini"]
assert g["configured"] is True and g["detail"]["keySource"] == "env", g["detail"]
assert g["detail"]["keyStorage"] == "env" and g["detail"]["keyLast4"] == "9fQ2", g["detail"]
PY
say "env key: source=env, last 4 only"
expect "PUT key with env set" 409 "$(json_put "http://127.0.0.1:$ENV_PORT/api/providers/gemini/key" '{"key":"other"}')"
detail_is key_from_env
expect "DELETE key with env set" 409 "$(code -X DELETE "http://127.0.0.1:$ENV_PORT/api/providers/gemini/key")"
detail_is key_from_env
stop_backend

# --- C. migration ------------------------------------------------------------
head2 "C. migration of a library without provider columns"
OLD="$TMP/old"
mkdir -p "$OLD"
"$PYTHON" - "$OLD/app.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.executescript("""
CREATE TABLE generations (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, model TEXT,
  aspect_ratio TEXT, resolution TEXT, status TEXT, error_message TEXT, raw_finish TEXT,
  output_image_id INTEGER, created_at TEXT, source TEXT NOT NULL DEFAULT 'vertex',
  client_task_id TEXT, marker_color TEXT);
CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL, aspect_ratio TEXT, resolution TEXT,
  output_format TEXT NOT NULL DEFAULT 'image/jpeg',
  skip_if_preceding_succeeds INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  legacy_generation_id INTEGER UNIQUE REFERENCES generations(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO generations (prompt, model, status, created_at) VALUES
  ('old one', 'gemini-3-pro-image', 'success', '2026-01-01T00:00:00+00:00'),
  ('old note', 'gemini-2.5-flash-image', 'note', '2026-01-02T00:00:00+00:00');
INSERT INTO drafts (prompt, model, created_at, updated_at) VALUES
  ('old draft', 'gemini-3-pro-image', '2026-01-03', '2026-01-03');
""")
c.commit()
PY
(cd "$BACKEND" && IMAGEN_DATA_DIR="$OLD" "$PYTHON" -c "from app.db import init_storage; init_storage(); init_storage()")
"$PYTHON" - "$OLD/app.db" <<'PY' || die "migration"
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
for t in ("generations", "drafts"):
    cols = {r[1]: r for r in c.execute(f"PRAGMA table_info({t})")}
    assert "provider" in cols and cols["provider"][3] == 1, (t, cols.get("provider"))
    vals = {r[0] for r in c.execute(f"SELECT provider FROM {t}")}
    assert vals == {"vertex"}, (t, vals)
n = c.execute("SELECT COUNT(*) FROM drafts WHERE legacy_generation_id IS NOT NULL").fetchone()[0]
assert n == 1, n
PY
say "provider columns added (NOT NULL), old rows + migrated note are 'vertex'; idempotent"

# --- D. fake backend -------------------------------------------------------
head2 "D. fake backend (port $FAKE_PORT)"
FDATA="$TMP/fake"
(
  cd "$BACKEND"
  "$PYTHON" ../desktop/scripts/seed_synthetic.py --data-dir "$FDATA" --images 2 --port "$FAKE_PORT"
) >"$TMP/seed.json" 2>"$TMP/seed.log" || { cat "$TMP/seed.log" >&2; die "seed failed"; }
(
  cd "$BACKEND"
  exec env -u IMAGEN_GEMINI_API_KEY IMAGEN_DATA_DIR="$FDATA" IMAGEN_PORT="$FAKE_PORT" \
    IMAGEN_LOG_DIR="$TMP/flogs" FAKE_DELAY_S=0 FAKE_OUTCOME=success \
    "$PYTHON" ../desktop/scripts/fake_backend.py
) >"$TMP/fake.log" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_health "$FAKE_PORT" || { cat "$TMP/fake.log" >&2; die "fake backend did not become healthy"; }

"$PYTHON" - "$FAKE_PORT" <<'PY'
import json
import sqlite3
import sys
import time

import httpx

base = f"http://127.0.0.1:{sys.argv[1]}"
c = httpx.Client(base_url=base, timeout=30)


def fail(msg):
    raise SystemExit(f"FAIL: {msg}")


def ok(msg):
    print(f"  PASS {msg}")


def generate(provider, fmt, model="gemini-3-pro-image", resolution="2K"):
    cid = f"prov-{provider}-{time.time_ns()}"
    r = c.post("/api/generate", json={
        "prompt": f"{provider} check", "provider": provider, "model": model,
        "aspectRatio": "1:1", "resolution": resolution, "outputFormat": fmt,
        "inputImageIds": [], "uploadImageIds": [], "clientTaskId": cid,
    })
    if r.status_code != 200:
        fail(f"{provider}: HTTP {r.status_code} {r.text[:200]}")
    return json.loads(r.text)


r = c.put("/api/providers/gemini", json={"enabled": True})
if r.status_code != 200:
    fail(f"enable gemini: {r.status_code}")

p = generate("gemini", "image/jpeg")
if p["status"] != "success":
    fail(f"gemini generate: {p}")
g = p["generation"]
if g["provider"] != "gemini" or g["model"] != "gemini-3-pro-image" or g["resolution"] != "2K":
    fail(f"gemini row: {g}")
if p["outputImage"]["mime"] != "image/jpeg":
    fail(f"gemini output not converted to JPG: {p['outputImage']['mime']}")
state = c.get("/__test/fake-state").json()
if state["provider"] != "gemini":
    fail(f"fake-state provider: {state}")
ok("gemini generation: row provider='gemini', PNG converted to JPG")

p = generate("gemini", "image/png", model="gemini-2.5-flash-image")
if p["status"] != "success" or p["outputImage"]["mime"] != "image/png":
    fail(f"gemini png: {p['status']} {p.get('outputImage')}")
if p["generation"]["resolution"] is not None:
    fail(f"flash kept a resolution: {p['generation']['resolution']}")
ok("gemini PNG stays PNG; Flash stores resolution NULL")

p = generate("vertex", "image/png", model="gemini-3-pro-image-preview")
if p["status"] != "success" or p["generation"]["provider"] != "vertex":
    fail(f"vertex generate: {p}")
if p["generation"]["model"] != "gemini-3-pro-image":
    fail(f"preview id not normalized: {p['generation']['model']}")
if c.get("/__test/fake-state").json()["provider"] != "vertex":
    fail("fake-state did not record vertex")
ok("vertex generation: row provider='vertex', preview id normalized")

# drafts
r = c.post("/api/drafts", json={"prompt": "d", "provider": "gemini", "model": "gemini-3-pro-image"})
if r.status_code != 200 or r.json()["provider"] != "gemini":
    fail(f"draft create: {r.status_code} {r.text[:200]}")
did = r.json()["id"]
r = c.patch(f"/api/drafts/{did}", json={"prompt": "d2"})
if r.json()["provider"] != "gemini":
    fail("draft patch without provider changed it")
r = c.patch(f"/api/drafts/{did}", json={"provider": "vertex"})
if r.json()["provider"] != "vertex":
    fail("draft patch provider")
if c.post("/api/drafts", json={"model": "x", "provider": "openai"}).status_code != 400:
    fail("draft with unknown provider accepted")
if c.post("/api/drafts", json={"model": "gemini-3-pro-image"}).json()["provider"] != "vertex":
    fail("draft default provider")
ok("drafts store provider (default vertex, unknown -> 400)")

# manual history: a provider that is off is still allowed
c.put("/api/providers/vertex", json={"enabled": False}).raise_for_status()
r = c.post("/api/generations/manual", json={"prompt": "m", "provider": "vertex",
                                            "model": "gemini-3-pro-image", "status": "success"})
if r.status_code != 200 or r.json()["provider"] != "vertex":
    fail(f"manual on a provider that is off: {r.status_code} {r.text[:200]}")
gid = r.json()["id"]
r = c.patch(f"/api/generations/{gid}", json={"prompt": "m", "provider": "gemini",
                                             "model": "gemini-3-pro-image", "status": "success"})
if r.json()["provider"] != "gemini":
    fail("manual edit provider")
if c.post("/api/generations/manual", json={"model": "x", "provider": "nope"}).status_code != 400:
    fail("manual with unknown provider accepted")
c.put("/api/providers/vertex", json={"enabled": True}).raise_for_status()
ok("manual history stores provider, even for a provider that is off")

# stats
s = c.get("/api/stats").json()["periods"]["all"]
if s["by_provider"].get("gemini", 0) < 3 or s["by_provider"].get("vertex", 0) < 1:
    fail(f"by_provider: {s['by_provider']}")
rows = s["cost_basis"]
if not rows or any("provider" not in r for r in rows):
    fail(f"cost_basis rows lack provider: {rows}")
if not any(r["provider"] == "gemini" and r["resolution"] == "2K" for r in rows):
    fail(f"no gemini 2K cost row: {rows}")
if any("provider" not in r for b in s["chart"] for r in b["cost_basis"]):
    fail("chart cost_basis lacks provider")
ok(f"stats: by_provider={s['by_provider']}, cost rows keyed by provider")
PY
stop_backend

# --- E. JPG conversion -----------------------------------------------------
head2 "E. PNG -> JPG conversion"
(cd "$BACKEND" && IMAGEN_DATA_DIR="$TMP/unit" "$PYTHON" - <<'PY') || die "conversion unit test"
import asyncio
import io

from PIL import Image, ImageCms

from app.providers import GenResult
from app.providers.gemini_api import _maybe_transcode, to_jpeg

icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
im = Image.new("RGBA", (8, 8), (255, 0, 0, 0))
im.putpixel((0, 0), (0, 0, 255, 255))
buf = io.BytesIO()
im.save(buf, format="PNG", icc_profile=icc)
png = buf.getvalue()

out = Image.open(io.BytesIO(to_jpeg(png)))
assert out.format == "JPEG" and out.mode == "RGB", (out.format, out.mode)
assert out.info.get("icc_profile") == icc, "ICC profile lost"
r, g, b = out.getpixel((7, 7))
assert min(r, g, b) > 240, ("transparent area not white", (r, g, b))
print("  PASS RGBA PNG -> RGB JPEG, white background, ICC kept")

res = asyncio.run(_maybe_transcode(
    GenResult(status="success", image_bytes=png, image_mime="image/png"), "image/jpeg", "t"))
assert res.image_mime == "image/jpeg" and res.image_bytes[:2] == b"\xff\xd8"
res = asyncio.run(_maybe_transcode(
    GenResult(status="success", image_bytes=png, image_mime="image/png"), "image/png", "t"))
assert res.image_mime == "image/png" and res.image_bytes == png
res = asyncio.run(_maybe_transcode(
    GenResult(status="success", image_bytes=b"not an image", image_mime="image/png"), "image/jpeg", "t"))
assert res.status == "success" and res.image_mime == "image/png" and res.image_bytes == b"not an image"
print("  PASS only JPG requests convert; a failed conversion keeps the original")
PY

printf '\nAll provider checks passed.\n'
