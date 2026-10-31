"""Vertex AI provider ("Nano Banana" via ADC).

Uses vertexai=True + project + location; credentials come from the machine's
Application Default Credentials (gcloud auth application-default login).
"""
import asyncio
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

ID = "vertex"
LABEL = "Vertex AI"

MODELS = (
    ModelSpec(id="gemini-3-pro-image", label="Nano Banana Pro",
              wire_id="gemini-3-pro-image", resolutions=PRO_RESOLUTIONS),
    ModelSpec(id="gemini-2.5-flash-image", label="Nano Banana",
              wire_id="gemini-2.5-flash-image"),
)

GATE = Gate(MIN_ATTEMPT_SPACING)

# Relax every *configurable* safety category to OFF, matching the official
# Vertex AI Studio sample, to minimize censorship for this self-use app. This
# covers both text-side and image-side harm categories. Note: Vertex still
# applies a non-configurable baseline image safety filter, so IMAGE_SAFETY can
# still occur — parse_response handles that gracefully.
_SAFETY_CATEGORIES = (
    *TEXT_SAFETY_CATEGORIES,
    "HARM_CATEGORY_IMAGE_HATE",
    "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT",
    "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_IMAGE_HARASSMENT",
)

# Cache one client per (project, location): construction resolves ADC (sync
# file IO) so it must not run per-call on the event loop. A racing first call
# may build twice; last-write-wins is harmless.
_clients: dict[tuple[str, str], genai.Client] = {}


async def _get_client(project: str, location: str) -> genai.Client:
    key = (project, location)
    client = _clients.get(key)
    if client is None:
        client = await asyncio.to_thread(
            genai.Client, vertexai=True, project=project, location=location
        )
        _clients[key] = client
    return client


def status() -> dict:
    project, location = provider_config.read_vertex()
    return {"configured": bool(project), "project": project, "location": location}


def build_config(
    model: ModelSpec,
    aspect_ratio: Optional[str],
    resolution: Optional[str],
    output_mime: Optional[str] = None,
) -> types.GenerateContentConfig:
    image_config = types.ImageConfig(
        aspect_ratio=aspect_ratio or None,
        image_size=resolution if (resolution and model.resolutions) else None,
        output_mime_type=output_mime or None,
    )
    return types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=image_config,
        safety_settings=safety_off(_SAFETY_CATEGORIES),
    )


def _api_error_message(code: Optional[int], detail: str) -> str:
    base = {
        400: "Bad request parameters (400)",
        401: "Invalid or unauthorized credentials (401)",
        403: "Permission denied (403): ensure the account has the Vertex AI User role and the aiplatform API is enabled",
        404: "Model not found or unavailable in this region (404)",
        429: "Quota / rate limit reached (429)",
    }.get(code or 0, f"Request failed ({code})" if code else "Request failed")
    return f"{base}：{detail}" if detail else base


def _is_missing_adc(e: Exception) -> bool:
    return "default credentials" in str(e).lower() or "DefaultCredentials" in type(e).__name__


_NO_ADC = (
    "No ADC credentials found. Run "
    "`gcloud auth application-default login` and "
    "`gcloud auth application-default set-quota-project <PROJECT_ID>` on this machine."
)


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
    project, location = provider_config.read_vertex()
    if not project:
        return GenResult(status="error", message="Vertex project not set. Please enter your Project ID in Settings.")
    try:
        client = await _get_client(project, location)
    except Exception as e:  # ADC / config resolution failure at construct time
        logger.warning("[%s] failed to create Vertex client: %s", tid, e)
        return GenResult(status="error", message=f"Failed to create Vertex client: {e}")
    contents = build_contents(prompt, images)
    config = build_config(model, aspect_ratio, resolution, output_mime)
    logger.info(
        "[%s] starting generation provider=vertex model=%s project=%s input_images=%d",
        tid, model.wire_id, project, len(images),
    )

    def _fatal(e: Exception) -> Optional[GenResult]:
        if _is_missing_adc(e):
            logger.warning("[%s] no ADC credentials found", tid)
            return GenResult(status="error", message=_NO_ADC)
        return None

    return await run_with_retry(
        lambda: client.aio.models.generate_content(
            model=model.wire_id, contents=contents, config=config
        ),
        gate=GATE,
        tid=tid,
        model_label=model.wire_id,
        error_message=_api_error_message,
        fatal_error=_fatal,
        on_event=on_event,
        should_abort=should_abort,
    )


async def check() -> dict:
    """Confirm the project + ADC can see the models. Never generates."""
    project, location = provider_config.read_vertex()
    if not project:
        return {"ok": False, "message": "Vertex project not set.", "models": []}
    try:
        client = await _get_client(project, location)
    except Exception as e:  # noqa: BLE001
        if _is_missing_adc(e):
            return {"ok": False, "message": _NO_ADC, "models": []}
        return {"ok": False, "message": f"Failed to create Vertex client: {e}", "models": []}
    found: list[str] = []
    for spec in MODELS:
        try:
            await client.aio.models.get(model=spec.wire_id)
            found.append(spec.wire_id)
        except errors.APIError as e:
            code = error_code(e)
            if code == 404:
                continue
            return {"ok": False, "message": _api_error_message(code, str(getattr(e, "message", e))),
                    "models": found}
        except Exception as e:  # noqa: BLE001
            if _is_missing_adc(e):
                return {"ok": False, "message": _NO_ADC, "models": found}
            return {"ok": False, "message": f"{type(e).__name__}: {e}", "models": found}
    if not found:
        return {"ok": False, "message": _api_error_message(404, ""), "models": []}
    return {"ok": True, "message": f"Connected to {project} ({location}).", "models": found}
