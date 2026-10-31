"""google-genai helpers shared by every provider: request/response mapping
and the retry loop. Provider modules only build the client and config."""
import asyncio
import logging
import random
import time
from typing import Awaitable, Callable, Optional

from google.genai import errors, types

from .base import Gate, GenResult, InputImage

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

MAX_ATTEMPTS = 30
MAX_NON_429_ATTEMPTS = 6
RETRYABLE_CODES = {429, 500, 502, 503, 504}
MIN_ATTEMPT_SPACING = 4.0

# Heartbeat watchdog: while a single generate_content attempt is in flight, log
# only if it stays unanswered past these thresholds. Normal fast generations
# print nothing; a genuinely stuck Gemini call surfaces here.
HEARTBEAT_FIRST_S = 20.0
HEARTBEAT_INTERVAL_S = 30.0

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
    "SAFETY": "Blocked by safety policy (SAFETY).",
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

# Text-side harm categories accepted by both Vertex and the Gemini API.
TEXT_SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_CIVIC_INTEGRITY",
)


def safety_off(categories) -> list[types.SafetySetting]:
    return [types.SafetySetting(category=c, threshold="OFF") for c in categories]


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


def parse_response(resp: types.GenerateContentResponse) -> GenResult:
    # Prompt-level block (request rejected before generation).
    feedback = getattr(resp, "prompt_feedback", None)
    if feedback and getattr(feedback, "block_reason", None):
        code = _enum_name(feedback.block_reason)
        msg = _HUMAN_BLOCK.get(code) or getattr(
            feedback, "block_reason_message", None
        ) or f"Prompt blocked ({code})."
        return GenResult(status="blocked", message=msg, raw_finish=code)

    candidates = resp.candidates or []
    if not candidates:
        return GenResult(status="error", message="Model returned no candidates.")

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
        return GenResult(
            status="success", image_bytes=image_bytes, image_mime=image_mime,
            text=text, raw_finish=finish,
        )

    # No image returned.
    if finish in BLOCK_FINISH:
        msg = _HUMAN_BLOCK.get(finish, f"Result blocked ({finish}).")
        return GenResult(status="blocked", message=msg, raw_finish=finish, text=text)

    msg = "Model returned no image."
    if text:
        msg += f"\nModel reply: {text}"
    return GenResult(status="blocked", message=msg, raw_finish=finish, text=text)


def _max_attempts_for(code: Optional[int]) -> int:
    return MAX_ATTEMPTS if code == 429 else MAX_NON_429_ATTEMPTS


def _retry_delay(attempt: int, code: Optional[int]) -> float:
    # Full-ish jitter avoids a batch of tasks waking up and retrying together.
    if code == 429:
        base = min(180.0, 8.0 * (1.7 ** attempt))
    else:
        base = min(60.0, 2.0 * (2 ** attempt))
    return (base * 0.5) + random.uniform(0.0, base * 0.5)


async def _schedule_retry(gate: Gate, attempt: int, code: Optional[int]) -> float:
    delay = _retry_delay(attempt, code)
    await gate.push_back(delay)
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


def error_code(e: Exception) -> Optional[int]:
    code = getattr(e, "code", None)
    return code if isinstance(code, int) else None


def _is_retryable_api_error(e: Exception) -> bool:
    code = error_code(e)
    return code in RETRYABLE_CODES


async def run_with_retry(
    call: Callable[[], Awaitable[types.GenerateContentResponse]],
    *,
    gate: Gate,
    tid: str,
    model_label: str,
    error_message: Callable[[Optional[int], str], str],
    fatal_error: Optional[Callable[[Exception], Optional[GenResult]]] = None,
    on_event: Optional[Callable[[dict], None]] = None,
    should_abort: Optional[Callable[[], bool]] = None,
) -> GenResult:
    """Send one generate_content attempt at a time until it settles.

    429 retries up to MAX_ATTEMPTS, other retryable codes and network errors
    up to MAX_NON_429_ATTEMPTS, other API errors return immediately.
    `error_message` renders a provider's wording for an HTTP code;
    `fatal_error` may turn an unexpected exception into a final result
    (e.g. missing credentials) instead of retrying it.
    """
    start_ts = time.monotonic()

    def _emit(ev: dict) -> None:
        # Best-effort progress for the UI; never let a bad callback break gen.
        if on_event is None:
            return
        try:
            on_event(ev)
        except Exception:  # noqa: BLE001
            pass

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
            return GenResult(
                status="aborted",
                message="User cancelled (stopped further retries).",
                raw_finish="ABORTED",
            )
        try:
            await gate.wait_slot()
            _emit({"phase": "sent", "attempt": attempt + 1})
            resp = await _await_with_heartbeat(call(), tid, attempt, model_label)
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
            code = error_code(e) or 500
            if attempt >= _max_attempts_for(code) - 1:
                break
            retries_done += 1
            delay = await _schedule_retry(gate, attempt, code)
            _emit({"phase": "retrying", "attempt": attempt + 1, "code": code, "delay": round(delay)})
            logger.warning(
                "[%s] attempt %d failed code=%s, will retry in ~%.0fs (%d total retries)",
                tid, attempt + 1, code, delay, retries_done,
            )
            continue
        except errors.APIError as e:  # ClientError and any other API error
            code = error_code(e)
            if _is_retryable_api_error(e) and attempt < _max_attempts_for(code) - 1:
                last_exc = e
                retries_done += 1
                delay = await _schedule_retry(gate, attempt, code)
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
            return GenResult(
                status="error",
                message=error_message(code, str(getattr(e, "message", e))),
                raw_finish=str(code or ""),
            )
        except Exception as e:  # network / unexpected / credentials
            fatal = fatal_error(e) if fatal_error else None
            if fatal is not None:
                return fatal
            last_exc = e
            if attempt >= MAX_NON_429_ATTEMPTS - 1:
                break
            retries_done += 1
            delay = await _schedule_retry(gate, attempt, None)
            _emit({"phase": "retrying", "attempt": attempt + 1, "code": None, "delay": round(delay)})
            logger.warning(
                "[%s] attempt %d failed (%s), will retry in ~%.0fs (%d total retries)",
                tid, attempt + 1, type(e).__name__, delay, retries_done,
            )
            continue

    code = error_code(last_exc) if last_exc else None
    detail = str(getattr(last_exc, "message", last_exc)) if last_exc else ""
    logger.warning(
        "[%s] failed code=%s, total %.1fs, %d retries",
        tid, code, time.monotonic() - start_ts, retries_done,
    )
    return GenResult(
        status="error",
        message=f"{error_message(code, detail)}; auto-scheduled {retries_done} retries.",
        raw_finish=str(code or ""),
    )
