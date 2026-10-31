"""Gemini Developer API provider (AI Studio, API key).

Differences from Vertex: the SDK rejects ImageConfig.output_mime_type in this
mode, so no format is requested and JPG is produced locally with Pillow; only
the text-side safety categories are relaxed (whether the IMAGE_* ones are
accepted here has not been verified).
"""
import asyncio
import hashlib
import io
import uuid
from typing import Callable, Optional

from google import genai
from google.genai import errors, types

from .. import provider_config
from .base import GenResult, Gate, InputImage, ModelSpec, PRO_RESOLUTIONS
from .genai_common import (
    MIN_ATTEMPT_SPACING, TEXT_SAFETY_CATEGORIES, build_contents, error_code,
    logger, run_with_retry, safety_off,
)

ID = "gemini"
LABEL = "Gemini API"

# Wire ids are not verified against a live key yet; Settings › Check
# connection lists what the key can see so they can be corrected here.
PRO_WIRE_ID = "gemini-3-pro-image-preview"
FLASH_WIRE_ID = "gemini-2.5-flash-image"

MODELS = (
    ModelSpec(id="gemini-3-pro-image", label="Nano Banana Pro",
              wire_id=PRO_WIRE_ID, resolutions=PRO_RESOLUTIONS,
              transcodes=("image/jpeg",)),
    ModelSpec(id="gemini-2.5-flash-image", label="Nano Banana",
              wire_id=FLASH_WIRE_ID, transcodes=("image/jpeg",)),
)

GATE = Gate(MIN_ATTEMPT_SPACING)

JPEG_QUALITY = 95

# One client per key, keyed by its hash so the cache never holds the key as a
# dict key. Construction is sync, so it runs off the event loop.
_clients: dict[str, genai.Client] = {}


def reset_clients() -> None:
    """Drop cached clients after the key is replaced or removed."""
    _clients.clear()


async def _get_client(key: str) -> genai.Client:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    client = _clients.get(digest)
    if client is None:
        client = await asyncio.to_thread(genai.Client, api_key=key)
        _clients.clear()
        _clients[digest] = client
    return client


def status() -> dict:
    key, source = provider_config.gemini_key()
    return {
        "configured": bool(key),
        "keySource": source,
        "keyLast4": provider_config.last4(key),
        "keyStorage": provider_config.key_storage(),
    }


def build_config(
    model: ModelSpec,
    aspect_ratio: Optional[str],
    resolution: Optional[str],
) -> types.GenerateContentConfig:
    image_config = types.ImageConfig(
        aspect_ratio=aspect_ratio or None,
        image_size=resolution if (resolution and model.resolutions) else None,
    )
    return types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=image_config,
        safety_settings=safety_off(TEXT_SAFETY_CATEGORIES),
    )


def _api_error_message(code: Optional[int], detail: str) -> str:
    if code == 400 and "API_KEY_INVALID" in detail:
        return "Invalid API key (400)"
    base = {
        400: "Bad request parameters (400)",
        401: "Invalid or unauthorized API key (401)",
        403: "Permission denied (403): the key cannot use this model or the Generative Language API is not enabled",
        404: "Model not available for this key (404)",
        429: "Quota / rate limit reached (429)",
    }.get(code or 0, f"Request failed ({code})" if code else "Request failed")
    return f"{base}：{detail}" if detail else base


def to_jpeg(data: bytes) -> bytes:
    """Re-encode an image as JPEG (quality 95), keeping its ICC profile.

    Transparency is flattened onto white, since JPEG has no alpha.
    """
    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        icc = im.info.get("icc_profile")
        if im.mode == "P":
            im = im.convert("RGBA")
        if im.mode in ("RGBA", "LA"):
            rgba = im.convert("RGBA")
            out = Image.new("RGB", rgba.size, (255, 255, 255))
            out.paste(rgba, mask=rgba.getchannel("A"))
        elif im.mode != "RGB":
            out = im.convert("RGB")
        else:
            out = im
        buf = io.BytesIO()
        kwargs = {"quality": JPEG_QUALITY}
        if icc:
            kwargs["icc_profile"] = icc
        out.save(buf, format="JPEG", **kwargs)
    return buf.getvalue()


async def _maybe_transcode(result: GenResult, output_mime: Optional[str], tid: str) -> GenResult:
    if (
        result.status != "success"
        or output_mime != "image/jpeg"
        or (result.image_mime or "") == "image/jpeg"
        or not result.image_bytes
    ):
        return result
    try:
        result.image_bytes = await asyncio.to_thread(to_jpeg, result.image_bytes)
        logger.info("[%s] converted %s to image/jpeg locally", tid, result.image_mime)
        result.image_mime = "image/jpeg"
    except Exception as e:  # noqa: BLE001 — keep the original bytes
        logger.warning("[%s] JPEG conversion failed, keeping %s: %s", tid, result.image_mime, e)
    return result


async def generate(
    *,
    model: ModelSpec,
    prompt: str,
    aspect_ratio: Optional[str],
    resolution: Optional[str],
    images: list[InputImage],
    output_mime: Optional[str] = None,
    on_event: Optional[Callable[[dict], None]] = None,
    should_abort: Optional[Callable[[], bool]] = None,
) -> GenResult:
    tid = uuid.uuid4().hex[:6]
    key, _ = provider_config.gemini_key()
    if not key:
        return GenResult(status="error", message="Gemini API key not set. Add it in Settings › Providers.")
    try:
        client = await _get_client(key)
    except Exception as e:  # noqa: BLE001
        logger.warning("[%s] failed to create Gemini API client: %s", tid, type(e).__name__)
        return GenResult(status="error", message=f"Failed to create Gemini API client: {type(e).__name__}")
    contents = build_contents(prompt, images)
    config = build_config(model, aspect_ratio, resolution)
    logger.info(
        "[%s] starting generation provider=gemini model=%s input_images=%d",
        tid, model.wire_id, len(images),
    )
    result = await run_with_retry(
        lambda: client.aio.models.generate_content(
            model=model.wire_id, contents=contents, config=config
        ),
        gate=GATE,
        tid=tid,
        model_label=model.wire_id,
        error_message=_api_error_message,
        on_event=on_event,
        should_abort=should_abort,
    )
    if result.status == "success":
        logger.info("[%s] returned mime=%s", tid, result.image_mime)
    return await _maybe_transcode(result, output_mime, tid)


async def check() -> dict:
    """List the image models the key can see. Never generates."""
    key, _ = provider_config.gemini_key()
    if not key:
        return {"ok": False, "message": "Gemini API key not set.", "models": [], "expected": []}
    try:
        client = await _get_client(key)
        names: list[str] = []
        async for m in await client.aio.models.list():
            name = (m.name or "").removeprefix("models/")
            if "image" in name:
                names.append(name)
    except errors.APIError as e:
        return {
            "ok": False,
            "message": _api_error_message(error_code(e), str(getattr(e, "message", e))),
            "models": [], "expected": [],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"{type(e).__name__}: {e}", "models": [], "expected": []}
    expected = [
        {"id": spec.id, "wireId": spec.wire_id, "found": spec.wire_id in names}
        for spec in MODELS
    ]
    missing = [x["wireId"] for x in expected if not x["found"]]
    message = "Key works." if not missing else f"Key works, but not listed: {', '.join(missing)}"
    return {"ok": True, "message": message, "models": sorted(names), "expected": expected}
