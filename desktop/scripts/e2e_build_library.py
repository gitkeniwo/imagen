#!/usr/bin/env python3
"""Build the deterministic test library used by the Playwright UI checks.

Every write goes through the public HTTP API (the same calls the UI makes):
uploads (incl. Chinese names, GIF, a dedup'd duplicate), generations with
lineage chains and forks, blocked/error outcomes, tags, favorites, renames,
drafts, soft deletion + restore, and imported history across past months.
No provider is contacted: the target must be ``e2e_fake_backend.py``.

The content is fixed (seeded images, sequential generations), so IDs, counts
and tag counts are the same on every run. Only timestamps follow the clock:
generations are stamped "now" and imported history is relative to now.

Usage (from the repo root):

    # Start a fresh fake backend on a new directory, build, stop it:
    uv run --project backend python desktop/scripts/e2e_build_library.py \
        --data-dir "$TMPDIR/imagen-e2e-template" --port 47919

    # Or populate an already-running fake backend:
    uv run --project backend python desktop/scripts/e2e_build_library.py \
        --base http://127.0.0.1:47951

``--base`` defaults to ``$IMAGEN_E2E_BASE``. ``--data-dir`` must be missing or
empty and must not be the real data directory or ``~/.config/imagen``.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import random
import secrets
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parents[1]
MARKER = ".synthetic"
RESERVED_PORTS = {8000, 47860}  # user's Docker container / desktop app
FORBIDDEN = [REPO / "backend" / "data", Path.home() / ".config" / "imagen"]


def ok(r: httpx.Response, what: str):
    if r.status_code >= 400:
        sys.exit(f"{what}: HTTP {r.status_code} {r.text[:400]}")
    return json.loads(r.text.strip() or "{}")


def font(sz):
    try:
        return ImageFont.load_default(size=sz)
    except TypeError:
        return ImageFont.load_default()


def scene(kind: str, w: int, h: int, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    bg = tuple(rnd.randrange(30, 230) for _ in range(3))
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    if kind == "product":
        cx = w // 2
        d.rounded_rectangle([cx - w // 8, h // 4, cx + w // 8, h * 7 // 8], radius=w // 20,
                            fill=tuple(rnd.randrange(0, 256) for _ in range(3)), outline=(255, 255, 255), width=4)
        d.rectangle([cx - w // 20, h // 6, cx + w // 20, h // 4], fill=(40, 40, 40))
        d.ellipse([cx - w // 4, h * 13 // 16, cx + w // 4, h * 15 // 16], fill=(0, 0, 0, 80))
    elif kind == "portrait":
        cx = w // 2
        d.ellipse([cx - w // 6, h // 6, cx + w // 6, h // 6 + w // 3], fill=(234, 192, 160))
        d.pieslice([cx - w // 3, h // 2, cx + w // 3, h + h // 3], 180, 360,
                   fill=tuple(rnd.randrange(0, 200) for _ in range(3)))
    elif kind == "texture":
        for _ in range(400):
            x, y = rnd.randrange(w), rnd.randrange(h)
            r = rnd.randrange(4, max(5, w // 30))
            d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rnd.randrange(0, 256) for _ in range(3)))
    else:  # landscape
        for i in range(6):
            y = h // 3 + i * h // 12
            d.polygon([(0, h), (0, y), (w // 3, y - rnd.randrange(h // 10, h // 4)),
                       (w * 2 // 3, y - rnd.randrange(0, h // 5)), (w, y), (w, h)],
                      fill=tuple(max(0, v - i * 25) for v in bg))
        d.ellipse([w * 3 // 4, h // 10, w * 3 // 4 + w // 10, h // 10 + w // 10], fill=(255, 230, 160))
    d.rectangle([0, 0, w, 40], fill=(0, 0, 0))
    d.text((10, 8), f"test-lib · {kind} #{seed}", fill=(255, 255, 255), font=font(24))
    return im


def encode(im: Image.Image, fmt: str) -> bytes:
    b = io.BytesIO()
    im.save(b, fmt, **({"quality": 90} if fmt in ("JPEG", "WEBP") else {}))
    return b.getvalue()


def populate(c: httpx.Client) -> dict:
    def upload(files):
        return ok(c.post("/api/images", files=[("files", f) for f in files]), "upload")["images"]

    # Vertex needs a project before it accepts a generation; this one is fake.
    ok(c.put("/api/settings/vertex", json={"project": "synthetic-not-a-project", "location": "global"}),
       "vertex settings")

    # ---------- 1. themed uploads (incl. Chinese filenames, GIF, a duplicate) ----------
    specs = [
        ("产品-香水瓶.png", "product", 1200, 1500, "PNG"),
        ("product-sneaker.jpg", "product", 1600, 1200, "JPEG"),
        ("product-mug.webp", "product", 1024, 1024, "WEBP"),
        ("人像-正面.jpg", "portrait", 1080, 1350, "JPEG"),
        ("portrait-side.png", "portrait", 1200, 1600, "PNG"),
        ("texture-terrazzo.png", "texture", 1024, 1024, "PNG"),
        ("texture-confetti.webp", "texture", 1600, 900, "WEBP"),
        ("landscape-alps.jpg", "landscape", 1920, 1080, "JPEG"),
        ("landscape-dunes.jpg", "landscape", 2400, 1000, "JPEG"),
        ("风景-海港.png", "landscape", 1600, 1000, "PNG"),
        ("a-very-long-filename-to-check-truncation-in-the-tiles-and-viewer-panel-final-v3.jpg",
         "landscape", 1000, 1500, "JPEG"),
    ]
    files = []
    for i, (name, kind, w, h, fmt) in enumerate(specs):
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[fmt]
        files.append((name, encode(scene(kind, w, h, 100 + i), fmt), mime))
    frames = [scene("texture", 480, 480, 300 + k) for k in range(4)]
    gb = io.BytesIO()
    frames[0].save(gb, "GIF", save_all=True, append_images=frames[1:], duration=300, loop=0)
    files.append(("sticker-animated.gif", gb.getvalue(), "image/gif"))
    up = upload(files)
    # duplicate upload (same bytes, different name) -> dedup by sha256
    dup = upload([("product-sneaker-COPY.jpg", files[1][1], "image/jpeg")])
    assert dup[0]["id"] == up[1]["id"], "sha256 dedup failed"
    U = {s[0]: img for s, img in zip(specs + [("sticker-animated.gif",)], up)}
    ids = {k: v["id"] for k, v in U.items()}

    # ---------- 2. tags (Chinese + English, colors) ----------
    tags = {}
    for name, color in [("海报项目", "#e03131"), ("人物", "#f08c00"), ("产品", "#1c7ed6"),
                        ("风格参考", "#7048e8"), ("client:acme", "#0ca678"), ("待修", "#868e96")]:
        tags[name] = ok(c.post("/api/tags", json={"name": name, "color": color}), "tag")["id"]

    def batch_tag(image_ids, tag_ids):
        ok(c.post("/api/tags/batch", json={"imageIds": image_ids, "tagIds": tag_ids, "op": "add"}), "batch tag")

    batch_tag([ids["产品-香水瓶.png"], ids["product-sneaker.jpg"], ids["product-mug.webp"]], [tags["产品"]])
    batch_tag([ids["人像-正面.jpg"], ids["portrait-side.png"]], [tags["人物"]])
    batch_tag([ids["texture-terrazzo.png"], ids["texture-confetti.webp"], ids["sticker-animated.gif"]],
              [tags["风格参考"]])

    # ---------- 3. provider: enable Gemini API (fake key reported by the fake backend) ----------
    ok(c.put("/api/providers/gemini", json={"enabled": True}), "enable gemini")

    def gen(prompt, inputs, *, model="gemini-3-pro-image", ar="1:1", res="1K", fmt="image/jpeg",
            provider="vertex", tag_ids=(), marker=None):
        body = {"prompt": prompt, "provider": provider, "model": model, "aspectRatio": ar,
                "resolution": res if model == "gemini-3-pro-image" else None, "outputFormat": fmt,
                "inputImageIds": list(inputs), "tagIds": list(tag_ids)}
        if marker:
            body["markerColor"] = marker
        res_ = ok(c.post("/api/generate", json=body), f"generate {prompt[:30]}")
        out = res_.get("outputImage") or {}
        print(f"  gen {res_.get('status'):8} out={out.get('id')} <- {list(inputs)} :: {prompt[:50]}")
        return res_

    def out_id(r):
        return (r.get("outputImage") or {}).get("id")

    # ---------- 4. lineage chains (outputs feed later inputs) ----------
    P = tags["海报项目"]
    g1 = gen("香水瓶放在大理石台面上, 柔和晨光, 产品海报", [ids["产品-香水瓶.png"], ids["texture-terrazzo.png"]],
             ar="4:5", res="2K", tag_ids=[P, tags["产品"]])
    g2 = gen("Place the model holding the perfume bottle, editorial look",
             [out_id(g1), ids["人像-正面.jpg"]], ar="4:5", res="2K", tag_ids=[P])
    g3 = gen("Same composition, swap background for the alpine landscape",
             [out_id(g2), ids["landscape-alps.jpg"]], ar="16:9", res="4K", fmt="image/png", tag_ids=[P])
    g4 = gen("Final poster: combine all three iterations into a triptych",
             [out_id(g1), out_id(g2), out_id(g3)], ar="21:9", res="4K", tag_ids=[P, tags["client:acme"]],
             marker="red")
    # second branch from g1 (fork in lineage)
    g5 = gen("Flat-lay variant with confetti texture, top-down",
             [out_id(g1), ids["texture-confetti.webp"]], model="gemini-2.5-flash-image", ar="1:1", tag_ids=[P])
    g6 = gen("Sneaker on dunes at golden hour", [ids["product-sneaker.jpg"], ids["landscape-dunes.jpg"]],
             ar="3:2", res="2K", provider="gemini", tag_ids=[tags["产品"], tags["client:acme"]])
    gen("Mug product shot, PNG for transparency test", [ids["product-mug.webp"]],
        ar="1:1", res="1K", fmt="image/png", provider="gemini")
    gen("Text-to-image with no references: neon city skyline", [], ar="9:16", res="2K")
    gen("Portrait retouch [blocked]", [ids["portrait-side.png"]], ar="3:4")
    gen("Portrait retouch, softer wording", [ids["portrait-side.png"]], ar="3:4", tag_ids=[tags["人物"]])
    gen("Harbor night scene [error]", [ids["风景-海港.png"]], ar="16:9", provider="gemini")
    gen("Harbor night scene", [ids["风景-海港.png"], out_id(g6)], ar="16:9", provider="gemini")
    gen("Animated sticker as reference (GIF input)", [ids["sticker-animated.gif"]], ar="1:1",
        model="gemini-2.5-flash-image")
    # 4 tries of the same prompt; sequential (not parallel) so IDs are stable.
    tries = [gen("Mascot sticker sheet, try %d" % (k + 1), [out_id(g5)], ar="5:4",
                 model="gemini-2.5-flash-image") for k in range(4)]

    # ---------- 5. drafts ----------
    drafts = [
        {"prompt": "下一版海报: 文字留白放在左侧", "model": "gemini-3-pro-image", "aspectRatio": "4:5",
         "resolution": "2K", "inputImageIds": [out_id(g4), ids["产品-香水瓶.png"]],
         "outputImageIds": [out_id(g3)], "tagIds": [P], "pinned": True},
        {"prompt": "Sneaker campaign — try a night version", "provider": "gemini", "model": "gemini-3-pro-image",
         "aspectRatio": "3:2", "resolution": "4K", "outputFormat": "image/png",
         "inputImageIds": [out_id(g6)], "outputImageIds": [], "tagIds": [tags["client:acme"]]},
        {"prompt": "", "model": "gemini-2.5-flash-image", "aspectRatio": "1:1",
         "inputImageIds": [ids["texture-terrazzo.png"], ids["texture-confetti.webp"], ids["sticker-animated.gif"]],
         "outputImageIds": [], "tagIds": [], "skipIfPrecedingSucceeds": True},
    ]
    for d in drafts:
        ok(c.post("/api/drafts", json=d), "draft")

    # ---------- 6. favorites, notes, renames, source flips, tag cover ----------
    ok(c.patch(f"/api/images/{out_id(g4)}", json={"starred": True, "note": "客户选定版本 ✅ — 交付 2026-11-10"}),
       "star")
    ok(c.patch(f"/api/images/{out_id(g3)}", json={"starred": True, "filename": "poster-alps-4k.png"}), "rename")
    ok(c.patch(f"/api/images/{ids['landscape-dunes.jpg']}", json={"source": "generated",
                                                                 "note": "Imported from an older Midjourney run"}),
       "source flip")
    ok(c.patch(f"/api/tags/{P}", json={"coverImageId": out_id(g4)}), "cover")
    batch_tag([out_id(tries[0]), out_id(tries[1])], [tags["待修"]])

    # ---------- 7. bin: delete two, restore one ----------
    ok(c.delete(f"/api/images/{out_id(tries[2])}"), "bin")
    ok(c.delete(f"/api/images/{out_id(tries[3])}"), "bin")
    ok(c.post(f"/api/images/{out_id(tries[3])}/restore"), "restore")

    # ---------- 8. manual (imported) history across past months, for usage stats ----------
    now = datetime.now(timezone.utc)
    for k in range(10):
        status = ["success", "success", "success", "blocked", "error"][k % 5]
        ok(c.post("/api/generations/manual", json={
            "prompt": f"Imported run {k + 1} from old workflow",
            "provider": "gemini" if k % 2 else "vertex",
            "model": "gemini-3-pro-image" if k % 3 else "gemini-2.5-flash-image",
            "aspectRatio": ["1:1", "16:9", "3:4"][k % 3], "resolution": "2K",
            "status": status, "source": "manual",
            "errorMessage": None if status == "success" else ("IMAGE_SAFETY" if status == "blocked" else "429 quota"),
            "inputImageIds": [ids["landscape-alps.jpg"]] if k % 2 else [],
            # A successful record needs an output; all point at the one image
            # already marked as imported, so uploads stay uploads.
            "outputImageId": ids["landscape-dunes.jpg"] if status == "success" else None,
            "createdAt": (now - timedelta(days=12 * k + 3)).isoformat(),
        }), "manual")

    summary = {
        "images": ok(c.get("/api/images", params={"limit": 1}), "imgs")["total"],
        "generations": ok(c.get("/api/generations", params={"limit": 1}), "gens")["total"],
        "tags": {t["name"]: t["count"] for t in ok(c.get("/api/tags"), "tags")["tags"]},
        "drafts": len(ok(c.get("/api/drafts", params={"limit": 200}), "drafts")["drafts"]),
        "ids": {"uploads": ids, "poster_final": out_id(g4), "poster_alps": out_id(g3),
                "perfume_first": out_id(g1), "flatlay": out_id(g5), "sneaker_dunes": out_id(g6),
                "tries": [out_id(t) for t in tries]},
    }
    return summary


def _check_dir(data_dir: Path) -> None:
    resolved = data_dir.expanduser().resolve()
    for bad in FORBIDDEN:
        bad = bad.resolve()
        if resolved == bad or bad in resolved.parents:
            sys.exit(f"refusing to build into {resolved}: real data lives there")
    if resolved.exists() and any(p.name != ".DS_Store" for p in resolved.iterdir()):
        sys.exit(f"refusing to build into {resolved}: directory is not empty")


def _wait_health(client: httpx.Client, token: str, proc: subprocess.Popen, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    last = "no attempt"
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit(f"fake backend exited early with code {proc.returncode}")
        try:
            r = client.get("/api/health", timeout=2)
            if r.status_code == 200 and r.json().get("token") == token:
                return
            last = f"HTTP {r.status_code} {r.text[:120]}"
        except httpx.HTTPError as exc:
            last = str(exc)
        time.sleep(0.2)
    sys.exit(f"fake backend not healthy within {timeout:.0f}s ({last})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("IMAGEN_E2E_BASE"),
                    help="URL of a running e2e_fake_backend (default $IMAGEN_E2E_BASE)")
    ap.add_argument("--data-dir", help="start a fresh fake backend on this new/empty directory")
    ap.add_argument("--port", type=int, default=int(os.environ.get("IMAGEN_E2E_BUILD_PORT") or 47919),
                    help="port for --data-dir mode (47901-47999)")
    ap.add_argument("--log", help="backend log file for --data-dir mode")
    args = ap.parse_args()

    if not args.data_dir:
        if not args.base:
            ap.error("pass --data-dir (self-contained) or --base / IMAGEN_E2E_BASE")
        with httpx.Client(base_url=args.base, timeout=300) as c:
            print(json.dumps(populate(c), ensure_ascii=False))
        return 0

    if args.port in RESERVED_PORTS or not 47901 <= args.port <= 47999:
        ap.error("--port must be in 47901-47999")
    data_dir = Path(args.data_dir).expanduser().resolve()
    _check_dir(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(8)
    env = {**os.environ, "IMAGEN_DATA_DIR": str(data_dir), "IMAGEN_LIBRARY_MODE": "create",
           "IMAGEN_PORT": str(args.port), "IMAGEN_INSTANCE_TOKEN": token, "FAKE_DELAY_S": "0",
           "IMAGEN_LOG_DIR": str(Path(args.log).parent if args.log else data_dir.parent / f"{data_dir.name}-logs")}
    env.pop("IMAGEN_GEMINI_API_KEY", None)
    log_path = Path(args.log) if args.log else data_dir.parent / f"{data_dir.name}-backend.log"
    with log_path.open("w") as log:
        proc = subprocess.Popen([sys.executable, str(SCRIPTS / "e2e_fake_backend.py")], env=env,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{args.port}", timeout=300) as c:
                _wait_health(c, token, proc)
                summary = populate(c)
        finally:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
    (data_dir / MARKER).write_text(json.dumps({"ok": True, "builder": "e2e_build_library.py", **summary},
                                              ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
