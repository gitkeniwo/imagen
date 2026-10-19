#!/usr/bin/env python3
"""Seed an isolated Imagen data directory with synthetic content.

Writes go through the HTTP API only (never SQLite directly), so the script does
not depend on the schema. The target directory is marked with a `.synthetic`
file; `smoke_backend.sh` and manual verification use that marker to prove the
directory holds throwaway data.

Usage (from the repo root):

    uv run --project backend python desktop/scripts/seed_synthetic.py \
        --data-dir "$TMPDIR/imagen-seed" --images 50 --port 47902

Safety:
  * `--data-dir` is mandatory and must not be the real data directory.
  * An existing, non-empty directory is refused unless it already carries the
    `.synthetic` marker.
"""
from __future__ import annotations

import argparse
import hashlib
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
from PIL import Image, ImageDraw, ImageFont, ImageOps

MARKER = ".synthetic"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 47902
RESERVED_PORTS = {8000, 47860}  # user's Docker container / desktop app

# Deliberately relative to the repo and the user's Library, resolved lazily.
SIZES = [
    (640, 480),
    (800, 800),
    (1024, 768),
    (900, 1350),
    (1200, 900),
    (1600, 900),
    (1440, 1440),
    (2048, 1152),
]
FORMATS = [("PNG", "image/png", "png"), ("JPEG", "image/jpeg", "jpg"), ("WEBP", "image/webp", "webp")]
TAG_SPECS = [
    ("synthetic:portrait", "#e8590c"),
    ("synthetic:landscape", "#2f9e44"),
    ("synthetic:noise", "#1971c2"),
    ("synthetic:archive", "#9c36b5"),
]
PROMPTS = [
    "Synthetic gradient study",
    "Synthetic noise tile",
    "Synthetic color field with index marker",
    "Synthetic 4K plate (test data)",
]


def forbidden_roots() -> list[Path]:
    home = Path.home()
    return [
        (REPO_ROOT / "backend" / "data").resolve(),
        home / "Library" / "Application Support" / "com.gitkeniwo.imagen",
        home / "Library" / "WebKit",
        home / "Library" / "WebKit" / "com.gitkeniwo.imagen",
        home / "Library" / "Logs" / "com.gitkeniwo.imagen",
    ]


def check_data_dir(raw: str) -> Path:
    data_dir = Path(raw).expanduser().resolve()
    folded = str(data_dir).casefold()
    for root in forbidden_roots():
        root_s = str(root.resolve()).casefold()
        if folded == root_s or folded.startswith(root_s.rstrip("/") + os.sep):
            raise SystemExit(
                f"refusing --data-dir {data_dir}: it is inside the real data location {root}"
            )
    if data_dir == REPO_ROOT:
        raise SystemExit(f"refusing --data-dir {data_dir}: that is the repository root")

    if data_dir.exists():
        if not data_dir.is_dir():
            raise SystemExit(f"--data-dir {data_dir} is not a directory")
        entries = list(data_dir.iterdir())
        if entries and not (data_dir / MARKER).is_file():
            raise SystemExit(
                f"refusing non-empty --data-dir {data_dir}: no {MARKER} marker. "
                "Point the script at a fresh directory instead."
            )
    else:
        data_dir.mkdir(parents=True)
    return data_dir


def make_image(index: int, total: int) -> tuple[str, str, bytes, tuple[int, int], str]:
    rnd = random.Random(9000 + index)
    if index % 12 == 0:  # a few 4K-class images
        width, height = 3840, 2160
    else:
        width, height = rnd.choice(SIZES)
    fmt, mime, ext = FORMATS[index % len(FORMATS)]

    gradient = Image.linear_gradient("L").resize((width, height))
    dark = (rnd.randrange(0, 90), rnd.randrange(0, 90), rnd.randrange(0, 90))
    light = (rnd.randrange(120, 256), rnd.randrange(120, 256), rnd.randrange(120, 256))
    img = ImageOps.colorize(gradient, black=dark, white=light).convert("RGB")

    noise = Image.effect_noise((width, height), rnd.choice([16, 24, 32])).convert("RGB")
    img = Image.blend(img, noise, 0.10 + (index % 5) * 0.02)

    draw = ImageDraw.Draw(img)
    size = max(18, min(width, height) // 14)
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        font = ImageFont.load_default()
    label = f"synthetic #{index:02d}/{total} {width}x{height} {fmt}"
    draw.rectangle([0, 0, width, int(size * 1.8)], fill=(0, 0, 0))
    draw.text((max(8, size // 3), max(4, size // 5)), label, fill=(255, 255, 255), font=font)
    # A per-image marker guarantees a distinct sha256 even for equal sizes.
    draw.text((max(8, size // 3), height - int(size * 1.6)), f"seed-{secrets.token_hex(4)}",
              fill=(255, 255, 255), font=font)

    buf = io.BytesIO()
    save_kwargs = {}
    if fmt == "JPEG":
        save_kwargs = {"quality": 88}
    elif fmt == "WEBP":
        save_kwargs = {"quality": 85}
    img.save(buf, format=fmt, **save_kwargs)
    data = buf.getvalue()
    name = f"synthetic-{index:03d}.{ext}"
    return name, mime, data, (width, height), hashlib.sha256(data).hexdigest()


def wait_for_health(client: httpx.Client, token: str, timeout: float = 25.0) -> dict:
    deadline = time.time() + timeout
    last_error = "no attempt"
    while time.time() < deadline:
        try:
            res = client.get("/api/health")
            if res.status_code == 200:
                body = res.json()
                if body.get("app") == "imagen" and body.get("token") == token:
                    return body
                last_error = f"health token mismatch: {body}"
            else:
                last_error = f"HTTP {res.status_code}"
        except httpx.HTTPError as exc:
            last_error = str(exc)
        time.sleep(0.15)
    raise SystemExit(f"backend did not become healthy within {timeout:.0f}s ({last_error})")


def http_ok(res: httpx.Response, what: str) -> dict:
    if res.status_code >= 400:
        raise SystemExit(f"{what} failed: HTTP {res.status_code} {res.text[:500]}")
    return res.json()


def seed(client: httpx.Client, count: int) -> dict:
    created: list[dict] = []
    hashes: set[str] = set()
    formats: dict[str, int] = {}
    total_bytes = 0

    batch: list[tuple[str, str, bytes, tuple[int, int], str]] = []
    for index in range(count):
        item = make_image(index, count)
        batch.append(item)
        hashes.add(item[4])
        formats[item[1]] = formats.get(item[1], 0) + 1
        total_bytes += len(item[2])
        if len(batch) == 5 or index == count - 1:
            files = [("files", (name, data, mime)) for name, mime, data, _, _ in batch]
            body = http_ok(client.post("/api/images", files=files), "upload images")
            created.extend(body["images"])
            batch = []
            print(f"  uploaded {len(created)}/{count}", file=sys.stderr, flush=True)

    ids = [row["id"] for row in created]

    tags = [http_ok(client.post("/api/tags", json={"name": n, "color": c}), "create tag") for n, c in TAG_SPECS]
    tag_ids = [t["id"] for t in tags]
    tag_links = 0
    for offset, tag_id in enumerate(tag_ids):
        subset = ids[offset::4]
        if subset:
            http_ok(client.post("/api/tags/batch", json={"imageIds": subset, "tagIds": [tag_id], "op": "add"}),
                    "apply tag")
            tag_links += len(subset)

    starred = ids[:10]
    for image_id in starred:
        http_ok(client.patch(f"/api/images/{image_id}", json={"starred": True, "note": "synthetic favorite"}),
                "star image")

    binned = ids[-2:]
    for image_id in binned:
        http_ok(client.delete(f"/api/images/{image_id}"), "bin image")

    live = [i for i in ids if i not in set(binned)]
    drafts = []
    draft_specs = [
        {"prompt": PROMPTS[0], "model": "gemini-3-pro-image", "aspectRatio": "16:9",
         "resolution": "2K", "outputFormat": "image/jpeg",
         "inputImageIds": live[0:2], "outputImageIds": live[5:6], "tagIds": tag_ids[0:1], "pinned": True},
        {"prompt": PROMPTS[1], "model": "gemini-3-pro-image", "aspectRatio": "1:1",
         "resolution": "1K", "outputFormat": "image/png",
         "inputImageIds": live[7:8], "outputImageIds": [], "tagIds": tag_ids[1:2]},
        {"prompt": PROMPTS[2], "model": "gemini-2.5-flash-image", "aspectRatio": "4:3",
         "resolution": None, "outputFormat": "image/jpeg", "skipIfPrecedingSucceeds": True,
         "inputImageIds": live[9:11], "outputImageIds": [live[12]], "tagIds": tag_ids[2:4]},
        {"prompt": PROMPTS[3], "model": "gemini-3-pro-image", "aspectRatio": "3:2",
         "resolution": "4K", "outputFormat": "image/png",
         "inputImageIds": [], "outputImageIds": [], "tagIds": []},
    ]
    for spec in draft_specs:
        drafts.append(http_ok(client.post("/api/drafts", json=spec), "create draft"))

    now = datetime.now(timezone.utc)
    manual_specs = [
        ("success", live[20], None, "Synthetic success (logged manually)"),
        ("success", live[21], None, "Synthetic success #2"),
        ("blocked", None, "IMAGE_SAFETY", "Synthetic blocked"),
        ("blocked", None, "IMAGE_SAFETY", "Synthetic blocked #2"),
        ("error", None, "Synthetic upstream error (no Vertex call)", "Synthetic error"),
        ("error", None, "Synthetic timeout (no Vertex call)", "Synthetic error #2"),
    ]
    generation_status: dict[str, int] = {}
    for idx, (status, output_id, error, prompt) in enumerate(manual_specs):
        payload = {
            "prompt": prompt,
            "model": "gemini-3-pro-image",
            "aspectRatio": "16:9",
            "resolution": "2K",
            "status": status,
            "source": "manual",
            "errorMessage": error,
            "inputImageIds": live[idx:idx + 1],
            "outputImageId": output_id,
            "tagIds": tag_ids[:1] if status == "success" else [],
            "createdAt": (now - timedelta(days=idx, hours=idx)).isoformat(),
        }
        http_ok(client.post("/api/generations/manual", json=payload), "create manual generation")
        generation_status[status] = generation_status.get(status, 0) + 1

    http_ok(client.put("/api/settings/vertex",
                       json={"project": "synthetic-not-a-project", "location": "global"}),
            "set synthetic vertex project")

    images_body = http_ok(client.get("/api/images", params={"limit": 500}), "list images")
    drafts_body = http_ok(client.get("/api/drafts", params={"limit": 200}), "list drafts")
    gens_body = http_ok(client.get("/api/generations", params={"limit": 200}), "list generations")
    stats = http_ok(client.get("/api/stats"), "stats")

    return {
        "images": {
            "uploaded": len(created),
            "unique_sha256": len(hashes),
            "formats": formats,
            "uploaded_bytes": total_bytes,
            "live_after_seed": images_body["total"],
            "binned": len(binned),
            "starred": len(starred),
        },
        "tags": {"created": len(tag_ids), "links": tag_links,
                 "listed": len(http_ok(client.get("/api/tags"), "list tags")["tags"])},
        "drafts": {"created": len(drafts), "listed": drafts_body["total"]},
        "generations": {"manual_created": len(manual_specs), "by_status": generation_status,
                        "listed": gens_body["total"]},
        "stats": {"periods": list(stats["periods"].keys()), "tags": stats["tags"]},
        "settings": http_ok(client.get("/api/settings/vertex"), "read settings"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", required=True, help="isolated data directory (created if missing)")
    parser.add_argument("--images", type=int, default=50, help="number of synthetic images (default 50)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"backend port (default {DEFAULT_PORT})")
    args = parser.parse_args()

    if args.images < 1:
        parser.error("--images must be >= 1")
    if args.port in RESERVED_PORTS:
        parser.error(f"port {args.port} is reserved for the user's running app/container")
    if not 1 <= args.port <= 65535:
        parser.error("--port out of range")

    data_dir = check_data_dir(args.data_dir)
    print(f"seeding {data_dir} via 127.0.0.1:{args.port}", file=sys.stderr, flush=True)

    token = secrets.token_hex(16)
    env = os.environ.copy()
    env.update({
        "IMAGEN_DATA_DIR": str(data_dir),
        "IMAGEN_PORT": str(args.port),
        "IMAGEN_INSTANCE_TOKEN": token,
    })
    env.pop("IMAGEN_PARENT_WATCH", None)

    cmd = [sys.executable, "-m", "app.desktop"]
    proc = subprocess.Popen(cmd, cwd=REPO_ROOT / "backend", env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    client = httpx.Client(base_url=f"http://127.0.0.1:{args.port}", timeout=120.0)
    try:
        # Surface backend stderr if startup fails.
        try:
            wait_for_health(client, token)
        except SystemExit as exc:
            proc.terminate()
            try:
                _, err = proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                _, err = proc.communicate()
            raise SystemExit(f"{exc}\nbackend stderr:\n{(err or '')[-3000:]}")
        print("  backend healthy", file=sys.stderr, flush=True)
        summary_payload = seed(client, args.images)
    finally:
        client.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    summary = {
        "ok": True,
        "data_dir": str(data_dir),
        "marker": MARKER,
        "port": args.port,
        "backend": f"{Path(sys.executable).name} -m app.desktop",
        **summary_payload,
    }
    (data_dir / MARKER).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
