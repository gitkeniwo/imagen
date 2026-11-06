#!/usr/bin/env python3
"""Test-only backend for the Playwright UI checks (e2e/).

Wraps ``fake_backend.py`` (macOS only) and replaces every provider's
``generate`` with a richer fake. No provider is ever contacted.

* Output = collage of the input images (or a gradient when there are none),
  cropped to the requested aspect ratio, tinted by a prompt hash, with a
  "FAKE" caption. The render is a pure function of the request, so the same
  prompt + inputs always produce the same bytes (and sha256).
* Prompt markers drive outcomes: "[blocked]" -> IMAGE_SAFETY, "[error]" -> 403,
  "[slow]" -> a long wait (FAKE_SLOW_S, default 20 s) that honours cancel.
  Anything else succeeds after FAKE_DELAY_S seconds (default: random 2-5 s).

Before the server starts, the library is validated exactly like the real
desktop backend (``IMAGEN_LIBRARY_MODE`` existing/create/auto, lock file,
daily backup), so tests can run in ``existing`` mode against a prepared copy.

Never bundled: desktop/imagen-backend.spec only collects the ``app`` package.

Environment: IMAGEN_DATA_DIR (required), IMAGEN_PORT, IMAGEN_LIBRARY_MODE,
FAKE_DELAY_S, FAKE_SLOW_S.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import random
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(REPO / "backend"))
import fake_backend as fb  # noqa: E402

LONG = {"1K": 1024, "2K": 1600, "4K": 2400, None: 1024}


def _delay(prompt: str) -> float:
    if "[slow]" in prompt:
        return float(os.environ.get("FAKE_SLOW_S") or "20")
    raw = os.environ.get("FAKE_DELAY_S")
    return float(raw) if raw not in (None, "") else random.uniform(2, 5)


def _render(prompt: str, aspect: str, resolution, images, mime: str) -> tuple[bytes, str]:
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    h = hashlib.sha256((prompt + aspect + str(resolution) + str(len(images))).encode()).digest()
    rnd = random.Random(h)
    try:
        aw, ah = (int(x) for x in aspect.split(":"))
    except Exception:  # noqa: BLE001
        aw, ah = 1, 1
    long = LONG.get(resolution, 1024)
    if aw >= ah:
        w, hgt = long, max(1, round(long * ah / aw))
    else:
        w, hgt = max(1, round(long * aw / ah)), long
    canvas = Image.new("RGB", (w, hgt))
    srcs = []
    for im in images[:6]:
        try:
            srcs.append(Image.open(io.BytesIO(im.data)).convert("RGB"))
        except Exception:  # noqa: BLE001
            pass
    if srcs:
        n = len(srcs)
        for i, src in enumerate(srcs):
            x0, x1 = round(w * i / n), round(w * (i + 1) / n)
            tile = ImageOps.fit(src, (max(1, x1 - x0), hgt))
            canvas.paste(tile, (x0, 0))
    else:
        g = Image.linear_gradient("L").rotate(rnd.choice([0, 45, 90, 135]), expand=False).resize((w, hgt))
        canvas = ImageOps.colorize(g, black=tuple(rnd.randrange(0, 80) for _ in range(3)),
                                   white=tuple(rnd.randrange(150, 256) for _ in range(3))).convert("RGB")
    tint = Image.new("RGB", (w, hgt), (h[0], h[1], h[2]))
    canvas = Image.blend(canvas, tint, 0.28)
    d = ImageDraw.Draw(canvas)
    for _ in range(rnd.randrange(3, 8)):
        cx, cy, r = rnd.randrange(w), rnd.randrange(hgt), rnd.randrange(long // 20, long // 6)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255), width=max(2, long // 300))
    size = max(16, long // 32)
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:
        font = ImageFont.load_default()
    d.rectangle([0, hgt - int(size * 2.2), w, hgt], fill=(0, 0, 0))
    d.text((size // 2, hgt - int(size * 1.8)),
           f"FAKE · {aspect} {resolution or ''} · {len(images)} in · {prompt[:60]}",
           fill=(255, 255, 255), font=font)
    buf = io.BytesIO()
    if mime == "image/png":
        canvas.save(buf, "PNG")
    else:
        canvas.save(buf, "JPEG", quality=88)
        mime = "image/jpeg"
    return buf.getvalue(), mime


def install() -> None:
    from app import providers
    from app.providers import GenResult

    def make(pid):
        async def generate(*, model, prompt, aspect_ratio, resolution, images,
                           output_mime=None, on_event=None, should_abort=None):
            fb._LAST["provider"], fb._LAST["model"] = pid, model.id
            if on_event:
                try:
                    on_event({"phase": "sent", "attempt": 1})
                except Exception:  # noqa: BLE001
                    pass
            delay = _delay(prompt)
            waited = 0.0
            while waited < delay:
                if should_abort and should_abort():
                    return GenResult(status="aborted", message="aborted", raw_finish="ABORTED")
                step = min(0.25, delay - waited)
                await asyncio.sleep(step)
                waited += step
            if should_abort and should_abort():
                return GenResult(status="aborted", message="aborted", raw_finish="ABORTED")
            if "[blocked]" in prompt:
                return GenResult(status="blocked", message="Fake safety block", raw_finish="IMAGE_SAFETY")
            if "[error]" in prompt:
                return GenResult(status="error", message="Fake upstream error (403)", raw_finish="403")
            data, mime = await asyncio.to_thread(
                _render, prompt, aspect_ratio or "1:1", resolution, images, output_mime or "image/jpeg")
            return GenResult(status="success", image_bytes=data, image_mime=mime,
                             text="fake", raw_finish="STOP")
        return generate

    for pid, mod in providers.PROVIDERS.items():
        mod.generate = make(pid)


_orig_install = fb.install_fake_generate


def _install_both():
    _orig_install()   # keeps the fake Gemini key/status patches
    install()


fb.install_fake_generate = _install_both


def main() -> int:
    data_dir = (os.environ.get("IMAGEN_DATA_DIR") or "").strip()
    if data_dir and sys.platform == "darwin":
        # Same validation/lock/backup as app.desktop before app.db is imported.
        from app import desktop as desktop_entry
        from app.library import LibraryError, prepare_library

        try:
            path, mode = prepare_library(data_dir, os.environ.get("IMAGEN_LIBRARY_MODE") or "auto")
        except LibraryError as exc:
            return desktop_entry._fail(str(exc), exc.code)
        os.environ["IMAGEN_DATA_DIR"] = str(path)
        os.environ["IMAGEN_LIBRARY_MODE"] = mode
    return fb.main()


if __name__ == "__main__":
    sys.exit(main())
