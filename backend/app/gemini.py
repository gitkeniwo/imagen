"""Vertex AI ("Nano Banana") image generation via the google-genai SDK.

Uses Vertex AI with ADC (vertexai=True + project + location); credentials come
from the machine's Application Default Credentials (gcloud auth
application-default login). Results are normalized into GeminiResult:
  status = "success" -> image_bytes + image_mime present
  status = "blocked" -> safety/recitation/no-image block, message explains why
  status = "error"   -> API/network failure, message explains why
"""
import asyncio
import logging
import random
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from google import genai
from google.genai import errors, types

# Dedicated logger so generation debug info shows up on the backend terminal at
# INFO level without dragging in google-genai / grpc noise (own handler, no
# propagation to root).
logger = logging.getLogger("nano-banana.gemini")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [gemini] %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False

# Preview IDs can remain in browser state and historical generations after a
# model graduates. Normalize them at the API boundary so old clients keep
# working without sending retired model IDs to Vertex.
MODEL_ALIASES = {
    "gemini-3-pro-image-preview": "gemini-3-pro-image",
}


def normalize_model(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


# Models that support the imageConfig.image_size (1K/2K/4K) knob.
PRO_MODELS = {"gemini-3-pro-image"}

MAX_ATTEMPTS = 30
MAX_NON_429_ATTEMPTS = 6
RETRYABLE_CODES = {429, 500, 502, 503, 504}
MIN_VERTEX_ATTEMPT_SPACING = 4.0

# Heartbeat watchdog: while a single generate_content attempt is in flight, log
# only if it stays unanswered past these thresholds. Normal fast generations
# print nothing; a genuinely stuck Gemini call surfaces here.
HEARTBEAT_FIRST_S = 20.0
HEARTBEAT_INTERVAL_S = 30.0

_retry_gate_lock = asyncio.Lock()
_next_vertex_attempt_at = 0.0

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

# Relax every *configurable* safety category to OFF, matching the official
# Vertex AI Studio sample, to minimize censorship for this self-use app. This
# covers both text-side and image-side harm categories. Note: Vertex still
# applies a non-configurable baseline image safety filter, so IMAGE_SAFETY can
# still occur — parse_response handles that gracefully.
_SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_CIVIC_INTEGRITY",
    "HARM_CATEGORY_IMAGE_HATE",
    "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT",
    "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_IMAGE_HARASSMENT",
)

# finish_reason values that mean a result was withheld (no usable image).
BLOCK_FINISH = {
    "SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT",
    "RECITATION", "IMAGE_RECITATION", "BLOCKLIST", "SPII", "IMAGE_OTHER",
    "NO_IMAGE",
}

# Human-readable fallbacks stored on the generation row. The frontend also
# localizes these by code (raw_finish) for zh/en — keep the codes in sync with
# frontend/src/i18n.tsx reason_* keys.
_HUMAN_BLOCK = {
    "SAFETY": "Blocked by Vertex AI safety policy (SAFETY).",
    "IMAGE_SAFETY": "Image blocked by safety policy (IMAGE_SAFETY).",
    "PROHIBITED_CONTENT": "Flagged as prohibited content (PROHIBITED_CONTENT).",
    "IMAGE_PROHIBITED_CONTENT": "Image flagged as prohibited content (IMAGE_PROHIBITED_CONTENT).",
    "RECITATION": "Blocked for likely reciting copyrighted content (RECITATION).",
    "IMAGE_RECITATION": "Image blocked for likely reciting copyrighted content (IMAGE_RECITATION).",
    "BLOCKLIST": "Hit the blocklist (BLOCKLIST).",
    "SPII": "Possibly involves sensitive personal information (SPII).",
    "IMAGE_OTHER": "Image was not produced for another reason (IMAGE_OTHER).",
    "NO_IMAGE": "The model did not produce an image (NO_IMAGE).",
    "JAILBREAK": "Request flagged as a jailbreak attempt (JAILBREAK).",
    "MODEL_ARMOR": "Blocked by Model Armor policy (MODEL_ARMOR).",
}


@dataclass
class InputImage:
    data: bytes
    mime: str


@dataclass
class GeminiResult:
    status: str  # "success" | "blocked" | "error"
    message: Optional[str] = None
    raw_finish: Optional[str] = None
    image_bytes: Optional[bytes] = None
    image_mime: Optional[str] = None
    text: Optional[str] = None  # any text the model returned alongside/instead


def _enum_name(v) -> Optional[str]:
    if v is None:
        return None
    return getattr(v, "name", str(v))


def build_contents(prompt: str, images: list[InputImage]) -> list[types.Content]:
    parts: list[types.Part] = []
    if prompt:
        parts.append(types.Part.from_text(text=prompt))
    for im in images:
        parts.append(types.Part.from_bytes(data=im.data, mime_type=im.mime))
    return [types.Content(role="user", parts=parts)]


def build_config(
    model: str,
    aspect_ratio: Optional[str],
    resolution: Optional[str],
    output_mime: Optional[str] = None,
) -> types.GenerateContentConfig:
    image_config = types.ImageConfig(
        aspect_ratio=aspect_ratio or None,
        image_size=resolution if (resolution and model in PRO_MODELS) else None,
        output_mime_type=output_mime or None,
    )
    return types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=image_config,
        safety_settings=[
            types.SafetySetting(category=c, threshold="OFF")
            for c in _SAFETY_CATEGORIES
        ],
    )


def parse_response(resp: types.GenerateContentResponse) -> GeminiResult:
    # Prompt-level block (request rejected before generation).
    feedback = getattr(resp, "prompt_feedback", None)
    if feedback and getattr(feedback, "block_reason", None):
        code = _enum_name(feedback.block_reason)
        msg = _HUMAN_BLOCK.get(code) or getattr(
            feedback, "block_reason_message", None
        ) or f"Prompt blocked ({code})."
        return GeminiResult(status="blocked", message=msg, raw_finish=code)

    candidates = resp.candidates or []
    if not candidates:
        return GeminiResult(status="error", message="Model returned no candidates.")

    cand = candidates[0]
    finish = _enum_name(cand.finish_reason)
    parts = (cand.content.parts if cand.content else None) or []

    image_bytes = None
    image_mime = None
    text_chunks = []
    for p in parts:
        inline = getattr(p, "inline_data", None)
        if inline and inline.data:
            image_bytes = inline.data  # SDK already returns raw bytes
            image_mime = inline.mime_type or "image/png"
        elif getattr(p, "text", None):
            text_chunks.append(p.text)
    text = "\n".join(text_chunks) if text_chunks else None

    if image_bytes:
        return GeminiResult(
            status="success", image_bytes=image_bytes, image_mime=image_mime,
            text=text, raw_finish=finish,
        )

    # No image returned.
    if finish in BLOCK_FINISH:
        msg = _HUMAN_BLOCK.get(finish, f"Result blocked ({finish}).")
        return GeminiResult(status="blocked", message=msg, raw_finish=finish, text=text)

    msg = "Model returned no image."
    if text:
        msg += f"\nModel reply: {text}"
    return GeminiResult(status="blocked", message=msg, raw_finish=finish, text=text)


def _api_error_message(code: Optional[int], detail: str) -> str:
    base = {
        400: "Bad request parameters (400)",
        401: "Invalid or unauthorized credentials (401)",
        403: "Permission denied (403): ensure the account has the Vertex AI User role and the aiplatform API is enabled",
        404: "Model not found or unavailable in this region (404)",
        429: "Quota / rate limit reached (429)",
    }.get(code or 0, f"Request failed ({code})" if code else "Request failed")
    return f"{base}：{detail}" if detail else base


def _max_attempts_for(code: Optional[int]) -> int:
    return MAX_ATTEMPTS if code == 429 else MAX_NON_429_ATTEMPTS


def _retry_delay(attempt: int, code: Optional[int]) -> float:
    # Full-ish jitter avoids a batch of tasks waking up and retrying together.
    if code == 429:
        base = min(180.0, 8.0 * (1.7 ** attempt))
    else:
        base = min(60.0, 2.0 * (2 ** attempt))
    return (base * 0.5) + random.uniform(0.0, base * 0.5)


async def _wait_for_vertex_attempt_slot() -> None:
    """Process-wide pacing for outbound Vertex attempts.

    This is intentionally lightweight: it smooths bursts from the local app
    without introducing a durable queue.
    """
    global _next_vertex_attempt_at
    async with _retry_gate_lock:
        now = time.monotonic()
        wait = max(0.0, _next_vertex_attempt_at - now)
        if wait:
            await asyncio.sleep(wait)
        _next_vertex_attempt_at = time.monotonic() + MIN_VERTEX_ATTEMPT_SPACING


async def _schedule_retry(attempt: int, code: Optional[int]) -> float:
    global _next_vertex_attempt_at
    delay = _retry_delay(attempt, code)
    async with _retry_gate_lock:
        _next_vertex_attempt_at = max(
            _next_vertex_attempt_at,
            time.monotonic() + delay,
        )
    return delay


async def _await_with_heartbeat(coro, tid: str, attempt: int, model: str):
    """Await an in-flight attempt, logging a heartbeat if Gemini goes quiet.

    The watchdog only logs once an attempt exceeds HEARTBEAT_FIRST_S, so fast
    generations stay silent; a hung call keeps surfacing every interval.
    """
    start = time.monotonic()

    async def _beat():
        first = True
        while True:
            await asyncio.sleep(HEARTBEAT_FIRST_S if first else HEARTBEAT_INTERVAL_S)
            first = False
            logger.warning(
                "[%s] attempt %d still waiting for Gemini response (%s), %.0fs since start",
                tid, attempt + 1, model, time.monotonic() - start,
            )

    watcher = asyncio.create_task(_beat())
    try:
        return await coro
    finally:
        watcher.cancel()


def _error_code(e: Exception) -> Optional[int]:
    code = getattr(e, "code", None)
    return code if isinstance(code, int) else None


def _is_retryable_api_error(e: Exception) -> bool:
    code = _error_code(e)
    return code in RETRYABLE_CODES


async def generate(
    project: str,
    location: str,
    prompt: str,
    model: str,
    aspect_ratio: Optional[str],
    resolution: Optional[str],
    images: list[InputImage],
    output_mime: Optional[str] = None,
    on_event: Optional[Callable[[dict], None]] = None,
    should_abort: Optional[Callable[[], bool]] = None,
) -> GeminiResult:
    tid = uuid.uuid4().hex[:6]
    start_ts = time.monotonic()

    def _emit(ev: dict) -> None:
        # Best-effort progress for the UI; never let a bad callback break gen.
        if on_event is None:
            return
        try:
            on_event(ev)
        except Exception:  # noqa: BLE001
            pass
    try:
        client = await _get_client(project, location)
    except Exception as e:  # ADC / config resolution failure at construct time
        logger.warning("[%s] failed to create Vertex client: %s", tid, e)
        return GeminiResult(status="error", message=f"Failed to create Vertex client: {e}")
    contents = build_contents(prompt, images)
    config = build_config(model, aspect_ratio, resolution, output_mime)
    logger.info(
        "[%s] starting generation model=%s project=%s input_images=%d",
        tid, model, project, len(images),
    )

    last_exc: Optional[Exception] = None
    retries_done = 0
    for attempt in range(MAX_ATTEMPTS):
        # Cooperative cancel: if the client disconnected (user hit cancel), stop
        # BEFORE starting a new attempt / its backoff wait. We deliberately never
        # check mid-attempt, so the in-flight generate_content is left to finish —
        # a completed (billable) call is returned & kept, never discarded.
        if should_abort and should_abort():
            logger.info(
                "[%s] client cancelled, stopping further retries (completed %d attempts)", tid, attempt
            )
            return GeminiResult(
                status="aborted",
                message="User cancelled (stopped further retries).",
                raw_finish="ABORTED",
            )
        try:
            await _wait_for_vertex_attempt_slot()
            _emit({"phase": "sent", "attempt": attempt + 1})
            resp = await _await_with_heartbeat(
                client.aio.models.generate_content(
                    model=model, contents=contents, config=config
                ),
                tid, attempt, model,
            )
            result = parse_response(resp)
            elapsed = time.monotonic() - start_ts
            if result.status == "success":
                logger.info("[%s] success, total %.1fs, %d retries", tid, elapsed, retries_done)
            else:
                logger.info(
                    "[%s] blocked (%s), total %.1fs, %d retries",
                    tid, result.raw_finish or "?", elapsed, retries_done,
                )
            return result
        except errors.ServerError as e:
            last_exc = e
            code = _error_code(e) or 500
            if attempt >= _max_attempts_for(code) - 1:
                break
            retries_done += 1
            delay = await _schedule_retry(attempt, code)
            _emit({"phase": "retrying", "attempt": attempt + 1, "code": code, "delay": round(delay)})
            logger.warning(
                "[%s] attempt %d failed code=%s, will retry in ~%.0fs (%d total retries)",
                tid, attempt + 1, code, delay, retries_done,
            )
            continue
        except errors.ClientError as e:
            code = _error_code(e)
            if _is_retryable_api_error(e) and attempt < _max_attempts_for(code) - 1:
                last_exc = e
                retries_done += 1
                delay = await _schedule_retry(attempt, code)
                _emit({"phase": "retrying", "attempt": attempt + 1, "code": code, "delay": round(delay)})
                logger.warning(
                    "[%s] attempt %d failed code=%s, will retry in ~%.0fs (%d total retries)",
                    tid, attempt + 1, code, delay, retries_done,
                )
                continue
            logger.warning(
                "[%s] failed code=%s (not retryable), total %.1fs",
                tid, code, time.monotonic() - start_ts,
            )
            return GeminiResult(
                status="error",
                message=_api_error_message(code, str(getattr(e, "message", e))),
                raw_finish=str(code or ""),
            )
        except errors.APIError as e:
            code = _error_code(e)
            if _is_retryable_api_error(e) and attempt < _max_attempts_for(code) - 1:
                last_exc = e
                retries_done += 1
                delay = await _schedule_retry(attempt, code)
                _emit({"phase": "retrying", "attempt": attempt + 1, "code": code, "delay": round(delay)})
                logger.warning(
                    "[%s] attempt %d failed code=%s, will retry in ~%.0fs (%d total retries)",
                    tid, attempt + 1, code, delay, retries_done,
                )
                continue
            logger.warning(
                "[%s] failed code=%s (not retryable), total %.1fs",
                tid, code, time.monotonic() - start_ts,
            )
            return GeminiResult(
                status="error",
                message=_api_error_message(code, str(getattr(e, "message", e))),
                raw_finish=str(code or ""),
            )
        except Exception as e:  # network / unexpected / credentials
            if "default credentials" in str(e).lower() or "DefaultCredentials" in type(e).__name__:
                logger.warning("[%s] no ADC credentials found", tid)
                return GeminiResult(
                    status="error",
                    message="No ADC credentials found. Run "
                            "`gcloud auth application-default login` and "
                            "`gcloud auth application-default set-quota-project <PROJECT_ID>` on this machine.",
                )
            last_exc = e
            if attempt >= MAX_NON_429_ATTEMPTS - 1:
                break
            retries_done += 1
            delay = await _schedule_retry(attempt, None)
            _emit({"phase": "retrying", "attempt": attempt + 1, "code": None, "delay": round(delay)})
            logger.warning(
                "[%s] attempt %d failed (%s), will retry in ~%.0fs (%d total retries)",
                tid, attempt + 1, type(e).__name__, delay, retries_done,
            )
            continue

    code = _error_code(last_exc) if last_exc else None
    detail = str(getattr(last_exc, "message", last_exc)) if last_exc else ""
    logger.warning(
        "[%s] failed code=%s, total %.1fs, %d retries",
        tid, code, time.monotonic() - start_ts, retries_done,
    )
    return GeminiResult(
        status="error",
        message=f"{_api_error_message(code, detail)}; auto-scheduled {retries_done} retries.",
        raw_finish=str(code or ""),
    )
