"""Shared types for image providers (Vertex AI, Gemini API).

Results are normalized into GenResult:
  status = "success" -> image_bytes + image_mime present
  status = "blocked" -> safety/recitation/no-image block, message explains why
  status = "error"   -> API/network failure, message explains why
  status = "aborted" -> client cancelled before another attempt was started
"""
import asyncio
import time
from dataclasses import dataclass
from typing import Optional

# Preview IDs can remain in browser state and historical generations after a
# model graduates. Normalize them at the API boundary so old clients keep
# working; every provider maps the canonical id to its own wire id.
MODEL_ALIASES = {
    "gemini-3-pro-image-preview": "gemini-3-pro-image",
}


def normalize_model(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


ASPECT_RATIOS = (
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
)
PRO_RESOLUTIONS = ("1K", "2K", "4K")
OUTPUT_FORMATS = ("image/jpeg", "image/png")


@dataclass
class InputImage:
    data: bytes
    mime: str


@dataclass
class GenResult:
    status: str  # "success" | "blocked" | "error" | "aborted"
    message: Optional[str] = None
    raw_finish: Optional[str] = None
    image_bytes: Optional[bytes] = None
    image_mime: Optional[str] = None
    text: Optional[str] = None  # any text the model returned alongside/instead


@dataclass(frozen=True)
class ModelSpec:
    id: str          # canonical id, stored on generations/drafts
    label: str
    wire_id: str     # what this provider sends upstream
    resolutions: tuple[str, ...] = ()
    aspect_ratios: tuple[str, ...] = ASPECT_RATIOS
    output_formats: tuple[str, ...] = OUTPUT_FORMATS
    # Formats produced by converting locally instead of asking the API.
    transcodes: tuple[str, ...] = ()

    def public(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "resolutions": list(self.resolutions),
            "aspectRatios": list(self.aspect_ratios),
            "outputFormats": list(self.output_formats),
            "transcodes": list(self.transcodes),
        }


class Gate:
    """Process-wide pacing for outbound attempts to one provider.

    This is intentionally lightweight: it smooths bursts from the local app
    without introducing a durable queue. Each provider owns one, since their
    quotas are unrelated and must not share backoff.
    """

    def __init__(self, spacing: float) -> None:
        self.spacing = spacing
        self._lock = asyncio.Lock()
        self._next_at = 0.0

    async def wait_slot(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = max(0.0, self._next_at - now)
            if wait:
                await asyncio.sleep(wait)
            self._next_at = time.monotonic() + self.spacing

    async def push_back(self, delay: float) -> None:
        async with self._lock:
            self._next_at = max(self._next_at, time.monotonic() + delay)
