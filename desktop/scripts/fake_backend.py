#!/usr/bin/env python3
"""Test-only backend for the Tauri shell self-checks.

Reuses ``app.desktop``'s startup logic but replaces ``app.gemini.generate`` with
a controllable fake and mounts a few ``/__test/*`` pages that run checks inside
WKWebView, reporting results back over HTTP. Never shipped in the bundle: the
PyInstaller spec only collects the ``app`` package.

Environment:
  FAKE_DELAY_S   seconds the fake generation stays "waiting" (default 0)
  FAKE_OUTCOME   success | error | blocked (default success)
  IMAGEN_DATA_DIR  required (same guard as the real desktop backend)
  IMAGEN_PORT      default 47860
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

# Make `app` importable regardless of the caller's cwd, then import the entry
# module (safe: it does not import app.db, so no data directory is touched yet).
_BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))
from app import desktop as desktop_entry  # noqa: E402

REPORT_NAME = "test-report.log"
_ABORT_OBSERVATIONS: list[dict] = []
_STATE_LOCK = threading.Lock()
_LOG_PATH: Path | None = None


def _report(record: dict) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(), **record}
    line = json.dumps(record, ensure_ascii=False)
    print(f"REPORT {line}", flush=True)
    if _LOG_PATH is not None:
        with _STATE_LOCK:
            with _LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")


def _make_png() -> tuple[bytes, str]:
    from PIL import Image

    img = Image.new("RGB", (96, 96), (110, 170, 240))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), "image/png"


def install_fake_generate() -> None:
    """Patch app.gemini.generate before app.main imports it."""
    from app import gemini

    async def fake_generate(
        project,
        location,
        prompt,
        model,
        aspect_ratio,
        resolution,
        images,
        output_mime=None,
        on_event=None,
        should_abort=None,
    ):
        delay = float(os.environ.get("FAKE_DELAY_S") or "0")
        outcome = (os.environ.get("FAKE_OUTCOME") or "success").strip().lower()
        tid = f"fake-{os.getpid()}-{threading.get_ident()}"
        start = time.monotonic()
        if on_event:
            try:
                on_event({"phase": "sent", "attempt": 1})
            except Exception:  # noqa: BLE001
                pass
        print(
            f"FAKE generate start tid={tid} delay={delay} outcome={outcome} inputs={len(images)}",
            flush=True,
        )
        observed_abort = False
        while True:
            elapsed = time.monotonic() - start
            abort = bool(should_abort and should_abort())
            if abort:
                observed_abort = True
            with _STATE_LOCK:
                _ABORT_OBSERVATIONS.append(
                    {"elapsed": round(elapsed, 3), "should_abort": abort, "outcome": outcome}
                )
            if elapsed >= delay:
                break
            await asyncio.sleep(min(0.5, max(0.05, delay - elapsed)))
        total = time.monotonic() - start
        if observed_abort:
            print(f"FAKE generate aborted tid={tid} after {total:.1f}s", flush=True)
            return gemini.GeminiResult(
                status="aborted",
                message="Client disconnected before a response was stored.",
                raw_finish="ABORTED",
            )
        if outcome == "error":
            print(f"FAKE generate error tid={tid} after {total:.1f}s", flush=True)
            return gemini.GeminiResult(
                status="error", message="Fake upstream error (403)", raw_finish="403"
            )
        if outcome == "blocked":
            print(f"FAKE generate blocked tid={tid} after {total:.1f}s", flush=True)
            return gemini.GeminiResult(
                status="blocked", message="Fake safety block", raw_finish="IMAGE_SAFETY"
            )
        data, mime = _make_png()
        print(f"FAKE generate success tid={tid} after {total:.1f}s", flush=True)
        return gemini.GeminiResult(
            status="success", image_bytes=data, image_mime=mime, text="fake", raw_finish="STOP"
        )

    gemini.generate = fake_generate


TEST_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>imagen test __CHECK__</title>
<style>body{font-family:-apple-system,sans-serif;margin:24px}pre{white-space:pre-wrap}</style>
</head><body>
<h1>Imagen WKWebView test: <code>__CHECK__</code></h1>
<p id="state">running…</p>
<pre id="out"></pre>
<script>
const CHECK = "__CHECK__";
const out = document.getElementById("out");
const state = document.getElementById("state");
function show(o){ out.textContent += JSON.stringify(o) + "\\n"; }
async function report(o){ show(o); try { await fetch("/__test/report", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({check:CHECK, ...o})}); } catch(e){ show({report_error:String(e)}); } }
async function images(){ const r = await fetch("/api/images?limit=50"); if(!r.ok) throw new Error("images HTTP "+r.status); const j = await r.json(); return j.images||[]; }
function clickDownload(href, filename){ const a=document.createElement("a"); a.href=href; if(filename) a.download=filename; document.body.appendChild(a); a.click(); a.remove(); }
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function runLong(){
  await report({phase:"start"});
  const t0 = performance.now();
  const imgs = await images();
  const body = {prompt:"fake long generation", model:"gemini-3-pro-image", aspectRatio:"1:1",
    resolution:null, outputFormat:"image/png",
    inputImageIds: imgs.length ? [imgs[0].id] : [], uploadImageIds:[],
    clientTaskId:"wvlong-"+Date.now()};
  try {
    const r = await fetch("/api/generate", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    const text = await r.text();
    const ms = Math.round(performance.now()-t0);
    let parsed=null, parse_error=null;
    try { parsed = JSON.parse(text); } catch(e){ parse_error=String(e); }
    await report({phase:"result", http:r.status, ms, status: parsed&&parsed.status, parse_error, bytes:text.length});
  } catch(e){
    await report({phase:"result", ms:Math.round(performance.now()-t0), error:String(e)});
  }
}
async function runStorage(){
  const key = "imagen.__test_storage";
  const old = localStorage.getItem(key);
  if (old === null) {
    const value = "seed-"+Math.random().toString(36).slice(2);
    localStorage.setItem(key, value);
    await report({phase:"storage", mode:"initialized", value});
  } else {
    await report({phase:"storage", mode:"persisted", value:old});
  }
}
async function runClipboard(){
  try { await navigator.clipboard.writeText("imagen-clipboard-test"); await report({phase:"clipboard-write", result:"resolve"}); }
  catch(e){ await report({phase:"clipboard-write", result:"reject", error:String(e)}); }
  try { const t = await navigator.clipboard.readText(); await report({phase:"clipboard-read", text:t}); }
  catch(e){ await report({phase:"clipboard-read", result:"reject", error:String(e)}); }
}
async function runConfirm(){
  await report({phase:"before"});
  const t0 = performance.now();
  let value=null, error=null;
  try { value = window.confirm("imagen-confirm-test: ok?"); } catch(e){ error=String(e); }
  await report({phase:"after", value, ms:Math.round(performance.now()-t0), error});
}
async function runDownloads(){
  const imgs = await images();
  if(!imgs.length){ await report({phase:"downloads", error:"no images"}); return; }
  const id = imgs[0].id;
  const token = new URLSearchParams(location.search).get("token") || String(Date.now());
  const name = "imagen-dl-test-"+token+"-"+id+".png";
  const events = [];
  const onDownload = (e) => { events.push(e.detail); };
  window.addEventListener("imagen:download", onDownload);
  clickDownload("/api/images/"+id+"/file", name);
  await sleep(900);
  clickDownload("/api/images/"+id+"/file", name);
  await sleep(900);
  const ids = imgs.slice(0,2).map(i=>i.id).join(",");
  clickDownload("/api/images/batch-download?ids="+ids, "images.zip");
  for(let i=0; i<200 && events.length<3; i++) await sleep(100);
  window.removeEventListener("imagen:download", onDownload);
  const second = name.endsWith(".png") ? name.slice(0, -4) + " (1).png" : name + " (1)";
  const expected = [name, second, "images.zip"];
  const names = events.map(e => e && e.name);
  const ok = events.length===3 && events.every(e => e && e.ok===true)
    && expected.every((n,i) => names[i]===n);
  await report({phase:"downloads", image_id:id, filename:name, token, batch_ids:ids,
    expected, events, ok});
}
async function runBundle(){
  const html = await (await fetch("/")).text();
  const match = html.match(/<script[^>]+src="([^"]+[.]js)"/i);
  if(!match){ await report({phase:"bundle", error:"no JS asset in index.html"}); return; }
  const js = await (await fetch(match[1])).text();
  const needles = ["window.confirm", "window.alert", "window.prompt"];
  const hits = needles.filter(n => js.includes(n));
  const confirmSource = String(window.confirm);
  await report({phase:"bundle", script:match[1], bytes:js.length, hits,
    ok:hits.length===0, confirm_async:confirmSource.includes("async"),
    confirm_source:confirmSource.slice(0,220)});
}
(async ()=>{
  try {
    if(CHECK==="long") await runLong();
    else if(CHECK==="storage") await runStorage();
    else if(CHECK==="clipboard") await runClipboard();
    else if(CHECK==="confirm") await runConfirm();
    else if(CHECK==="downloads") await runDownloads();
    else if(CHECK==="bundle") await runBundle();
    else await report({phase:"error", error:"unknown check"});
    state.textContent = "done";
  } catch(e){ state.textContent = "fatal"; await report({phase:"fatal", error:String(e)+" | "+e.stack}); }
})();
</script></body></html>
"""


def install_test_routes(app) -> None:
    """Mount /__test/* *before* app.main's SPA catch-all route.

    Starlette matches routes in registration order, and app.main registers a
    ``/{full_path:path}`` fallback at import time, so appending here would never
    be reached. Build the routes on a throwaway app, then splice them in front
    of the catch-all.
    """
    from fastapi import FastAPI, Query
    from fastapi.responses import HTMLResponse, JSONResponse

    test_api = FastAPI()

    @test_api.get("/__test/run", response_class=HTMLResponse)
    def _run(check: str = Query("long")):
        return TEST_PAGE.replace("__CHECK__", check)

    @test_api.post("/__test/report")
    async def _report_endpoint(payload: dict):
        _report(payload)
        return {"ok": True}

    @test_api.get("/__test/fake-state")
    def _fake_state():
        with _STATE_LOCK:
            obs = list(_ABORT_OBSERVATIONS)
        return {
            "count": len(obs),
            "abort_seen": any(o["should_abort"] for o in obs),
            "first_abort": next((o for o in obs if o["should_abort"]), None),
            "last": obs[-3:],
        }

    @test_api.post("/__test/fake-reset")
    async def _fake_reset():
        with _STATE_LOCK:
            _ABORT_OBSERVATIONS.clear()
        return {"ok": True}

    @test_api.get("/__test/health")
    def _test_health():
        return JSONResponse({"ok": True, "test": True})

    routes = app.router.routes
    insert_at = len(routes)
    for i, route in enumerate(routes):
        if getattr(route, "path", "") == "/{full_path:path}":
            insert_at = i
            break
    routes[insert_at:insert_at] = list(test_api.router.routes)
    print(f"fake_backend: mounted {len(test_api.router.routes)} /__test routes at {insert_at}", flush=True)


def main() -> int:
    global _LOG_PATH

    if sys.platform != "darwin":
        print("fake_backend: this test harness targets macOS", file=sys.stderr)
        return 2

    data_dir = (os.environ.get("IMAGEN_DATA_DIR") or "").strip()
    if not data_dir:
        return desktop_entry._fail(
            "IMAGEN_DATA_DIR is not set. The desktop backend refuses to start "
            "without an explicit data directory."
        )
    try:
        port = desktop_entry._parse_port(os.environ.get("IMAGEN_PORT") or str(desktop_entry.DEFAULT_PORT))
    except ValueError as exc:
        return desktop_entry._fail(str(exc))

    log_dir = Path(os.environ.get("IMAGEN_LOG_DIR") or (Path(data_dir) / "logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    _LOG_PATH = log_dir / REPORT_NAME

    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

    install_fake_generate()
    import app.main as main_mod

    install_test_routes(main_mod.app)

    server = desktop_entry.build_server(main_mod.app, port)
    desktop_entry.start_parent_watch(server)
    _report({"phase": "backend", "port": port, "data_dir": data_dir, "log": str(_LOG_PATH)})
    print(f"fake_backend: listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
