"""Image providers. Every module exposes ID, LABEL, MODELS, status(),
generate(...) and check(); the app stores canonical model ids and lets each
provider map them to its own wire ids."""
from types import ModuleType

from . import gemini_api, vertex
from .base import (  # noqa: F401 — re-exported for routes and test doubles
    ASPECT_RATIOS, GenResult, InputImage, ModelSpec, normalize_model,
)

PROVIDERS: dict[str, ModuleType] = {"vertex": vertex, "gemini": gemini_api}


def get(provider_id: str) -> ModuleType | None:
    return PROVIDERS.get(provider_id)


def model_spec(provider_id: str, model_id: str) -> ModelSpec | None:
    mod = get(provider_id)
    if mod is None:
        return None
    model_id = normalize_model(model_id)
    return next((m for m in mod.MODELS if m.id == model_id), None)


def catalog(*, enabled: dict[str, bool], lan: bool) -> list[dict]:
    """Public description of every provider (GET /api/providers).

    Remote (LAN) devices don't get the Vertex project or the key's tail.
    """
    out = []
    for pid, mod in PROVIDERS.items():
        st = mod.status()
        detail = {k: v for k, v in st.items() if k != "configured"}
        if lan:
            detail.pop("project", None)
            detail.pop("keyLast4", None)
        out.append({
            "id": pid,
            "label": mod.LABEL,
            "enabled": enabled.get(pid, False),
            "configured": bool(st.get("configured")),
            "detail": detail,
            "models": [m.public() for m in mod.MODELS],
        })
    return out
