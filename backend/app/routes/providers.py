"""Provider catalog, on/off switches, Gemini API key and connection checks.

Remote (LAN) devices may read the catalog (without the Vertex project or the
key's tail) but every write and the connection check stay on the Mac.
"""
from fastapi import APIRouter, HTTPException, Request

from .. import provider_config, providers
from ..models import GeminiKeyBody, ProviderToggle
from ..remote_gate import is_lan

router = APIRouter(prefix="/api/providers", tags=["providers"])

MAX_KEY_LENGTH = 200


def _local_only(request: Request) -> None:
    if is_lan(request.scope):
        raise HTTPException(status_code=403, detail="Provider settings are managed on the Mac.")


def _catalog(request: Request) -> dict:
    return {
        "providers": providers.catalog(
            enabled=provider_config.enabled_map(), lan=is_lan(request.scope)
        )
    }


@router.get("")
def list_providers(request: Request):
    return _catalog(request)


@router.put("/gemini/key")
def put_gemini_key(body: GeminiKeyBody, request: Request):
    _local_only(request)
    key = body.key.strip()
    if not key or len(key) > MAX_KEY_LENGTH or any(c.isspace() for c in key):
        raise HTTPException(status_code=400, detail="Invalid API key format.")
    try:
        provider_config.set_gemini_key(key)
    except provider_config.KeyFromEnv:
        raise HTTPException(status_code=409, detail="key_from_env")
    except provider_config.KeyEnvOnly:
        raise HTTPException(status_code=409, detail="key_env_only")
    providers.gemini_api.reset_clients()
    return _catalog(request)


@router.delete("/gemini/key")
def delete_gemini_key(request: Request):
    _local_only(request)
    try:
        provider_config.delete_gemini_key()
    except provider_config.KeyFromEnv:
        raise HTTPException(status_code=409, detail="key_from_env")
    except provider_config.KeyEnvOnly:
        raise HTTPException(status_code=409, detail="key_env_only")
    providers.gemini_api.reset_clients()
    return _catalog(request)


@router.put("/{provider_id}")
def put_provider(provider_id: str, body: ProviderToggle, request: Request):
    _local_only(request)
    if providers.get(provider_id) is None:
        raise HTTPException(status_code=404, detail="Unknown provider")
    try:
        provider_config.set_enabled(provider_id, body.enabled)
    except ValueError:
        raise HTTPException(status_code=409, detail="last_provider")
    return _catalog(request)


@router.post("/{provider_id}/check")
async def check_provider(provider_id: str, request: Request):
    _local_only(request)
    mod = providers.get(provider_id)
    if mod is None:
        raise HTTPException(status_code=404, detail="Unknown provider")
    return await mod.check()
