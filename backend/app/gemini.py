"""Vertex AI ("Nano Banana") image generation via the google-genai SDK.

Uses Vertex AI with ADC (vertexai=True + project + location); credentials come
from the machine's Application Default Credentials (gcloud auth
application-default login). Results are normalized into GeminiResult:
  status = "success" -> image_bytes + image_mime present
  status = "blocked" -> safety/recitation/no-image block, message explains why
  status = "error"   -> API/network failure, message explains why
"""
import asyncio
import random
import time
from dataclasses import dataclass
from typing import Optional

from google import genai
from google.genai import errors, types

# Models that support the imageConfig.image_size (1K/2K/4K) knob.
PRO_MODELS = {"gemini-3-pro-image-preview"}

MAX_ATTEMPTS = 30
MAX_NON_429_ATTEMPTS = 6
RETRYABLE_CODES = {429, 500, 502, 503, 504}
MIN_VERTEX_ATTEMPT_SPACING = 4.0

_retry_gate_lock = asyncio.Lock()
_next_vertex_attempt_at = 0.0

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
    "SAFETY": "结果被 Vertex AI 安全策略拦截（SAFETY）。",
    "IMAGE_SAFETY": "图像被安全策略拦截（IMAGE_SAFETY）。",
    "PROHIBITED_CONTENT": "内容被判定为禁止内容（PROHIBITED_CONTENT）。",
    "IMAGE_PROHIBITED_CONTENT": "图像被判定为禁止内容（IMAGE_PROHIBITED_CONTENT）。",
    "RECITATION": "结果因疑似复述受版权保护内容被拦截（RECITATION）。",
    "IMAGE_RECITATION": "图像因疑似复述受版权保护内容被拦截（IMAGE_RECITATION）。",
    "BLOCKLIST": "命中屏蔽词表（BLOCKLIST）。",
    "SPII": "疑似涉及敏感个人信息（SPII）。",
    "IMAGE_OTHER": "图像因其它原因未生成（IMAGE_OTHER）。",
    "NO_IMAGE": "模型未生成图像（NO_IMAGE）。",
    "JAILBREAK": "请求被判定为越狱尝试（JAILBREAK）。",
    "MODEL_ARMOR": "被 Model Armor 策略拦截（MODEL_ARMOR）。",
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
        ) or f"Prompt 被拦截（{code}）。"
        return GeminiResult(status="blocked", message=msg, raw_finish=code)

    candidates = resp.candidates or []
    if not candidates:
        return GeminiResult(status="error", message="模型未返回任何候选结果。")

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
        msg = _HUMAN_BLOCK.get(finish, f"结果被拦截（{finish}）。")
        return GeminiResult(status="blocked", message=msg, raw_finish=finish, text=text)

    msg = "模型未返回图像。"
    if text:
        msg += f"\n模型回复：{text}"
    return GeminiResult(status="blocked", message=msg, raw_finish=finish, text=text)


def _api_error_message(code: Optional[int], detail: str) -> str:
    base = {
        400: "请求参数有误（400）",
        401: "凭据无效或未授权（401）",
        403: "无权限或被拒绝（403）：请确认账号有 Vertex AI User 角色、项目已启用 aiplatform API",
        404: "模型不存在或该区域不可用（404）",
        429: "触发配额/限流（429）",
    }.get(code or 0, f"请求失败（{code}）" if code else "请求失败")
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


async def _schedule_retry(attempt: int, code: Optional[int]) -> None:
    global _next_vertex_attempt_at
    delay = _retry_delay(attempt, code)
    async with _retry_gate_lock:
        _next_vertex_attempt_at = max(
            _next_vertex_attempt_at,
            time.monotonic() + delay,
        )


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
) -> GeminiResult:
    try:
        client = genai.Client(vertexai=True, project=project, location=location)
    except Exception as e:  # ADC / config resolution failure at construct time
        return GeminiResult(status="error", message=f"无法初始化 Vertex 客户端：{e}")
    contents = build_contents(prompt, images)
    config = build_config(model, aspect_ratio, resolution, output_mime)

    last_exc: Optional[Exception] = None
    retries_done = 0
    for attempt in range(MAX_ATTEMPTS):
        try:
            await _wait_for_vertex_attempt_slot()
            resp = await client.aio.models.generate_content(
                model=model, contents=contents, config=config
            )
            return parse_response(resp)
        except errors.ServerError as e:
            last_exc = e
            code = _error_code(e) or 500
            if attempt >= _max_attempts_for(code) - 1:
                break
            retries_done += 1
            await _schedule_retry(attempt, code)
            continue
        except errors.ClientError as e:
            code = _error_code(e)
            if _is_retryable_api_error(e) and attempt < _max_attempts_for(code) - 1:
                last_exc = e
                retries_done += 1
                await _schedule_retry(attempt, code)
                continue
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
                await _schedule_retry(attempt, code)
                continue
            return GeminiResult(
                status="error",
                message=_api_error_message(code, str(getattr(e, "message", e))),
                raw_finish=str(code or ""),
            )
        except Exception as e:  # network / unexpected / credentials
            if "default credentials" in str(e).lower() or "DefaultCredentials" in type(e).__name__:
                return GeminiResult(
                    status="error",
                    message="未找到 ADC 凭据。请在本机运行 "
                            "`gcloud auth application-default login` 并 "
                            "`gcloud auth application-default set-quota-project <项目ID>`。",
                )
            last_exc = e
            if attempt >= MAX_NON_429_ATTEMPTS - 1:
                break
            retries_done += 1
            await _schedule_retry(attempt, None)
            continue

    code = _error_code(last_exc) if last_exc else None
    detail = str(getattr(last_exc, "message", last_exc)) if last_exc else ""
    return GeminiResult(
        status="error",
        message=f"{_api_error_message(code, detail)}；已自动排期重试 {retries_done} 次。",
        raw_finish=str(code or ""),
    )
