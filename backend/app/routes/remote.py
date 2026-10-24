"""Remote (LAN) access API. Registered only in the desktop build.

Split by listener: login/hello/session answer on both; everything that
manages remote access is loopback-only and 404s on the LAN port.
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import remote
from ..remote_gate import is_lan

router = APIRouter(prefix="/api", tags=["remote"])


def loopback_only(request: Request) -> None:
    if is_lan(request.scope):
        raise HTTPException(status_code=404, detail="Not found")


class LoginBody(BaseModel):
    code: str = Field(default="", max_length=32)
    name: str | None = Field(default=None, max_length=80)
    remember: bool = True


class ConfigPatch(BaseModel):
    enabled: bool | None = None
    port: int | None = Field(default=None, ge=1024, le=65535)
    require_code: bool | None = None
    keep_awake: bool | None = None


@router.get("/remote/hello")
def hello():
    cfg = remote.config()
    return {"host_name": remote.host_name(), "require_code": cfg["require_code"]}


@router.post("/remote/login")
async def login(body: LoginBody, request: Request, response: Response):
    ip = (request.client.host if request.client else "") or ""
    await asyncio.sleep(remote.LOGIN_DELAY_S)
    result = await asyncio.to_thread(remote.verify_code, body.code.strip(), ip)
    if result.get("error") == "locked":
        return JSONResponse(result, status_code=429)
    if result.get("error"):
        return JSONResponse(result, status_code=401)
    token = remote.create_session(
        body.name, ip, request.headers.get("user-agent", "")
    )
    response.set_cookie(
        remote.COOKIE_NAME,
        token,
        max_age=remote.COOKIE_MAX_AGE if body.remember else None,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return {"ok": True}


@router.post("/remote/logout")
def logout(request: Request, response: Response):
    sid = request.scope.get("state", {}).get("remote_session")
    if sid:
        remote.revoke_session(sid)
    response.delete_cookie(remote.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/session")
def session(request: Request):
    """Who is asking: the local shell (remote=false) or a LAN device."""
    if not is_lan(request.scope):
        return {"remote": False, "host_name": None, "device": None}
    sid = request.scope.get("state", {}).get("remote_session")
    device = None
    if sid:
        s = remote.find_session_by_id(sid)
        if s:
            device = {"name": s["name"], "created_at": s["created_at"]}
    return {"remote": True, "host_name": remote.host_name(), "device": device}


@router.get("/remote/status", dependencies=[Depends(loopback_only)])
def get_status(recheck: bool = False):
    if recheck:
        # "Check again" in the popover: bypass the cached network/firewall reads.
        remote.clear_caches()
    return remote.status()


@router.put("/remote/config", dependencies=[Depends(loopback_only)])
async def put_config(body: ConfigPatch, request: Request):
    await remote.update_config(request.app, body.model_dump(exclude_unset=True))
    return await asyncio.to_thread(remote.status)


@router.post("/remote/code/regenerate", dependencies=[Depends(loopback_only)])
def regenerate():
    remote.regenerate_code()
    return remote.status()


@router.delete("/remote/sessions/{sid}", dependencies=[Depends(loopback_only)])
def delete_session(sid: str):
    if not remote.revoke_session(sid):
        raise HTTPException(status_code=404, detail="Not found")
    return remote.status()


@router.delete("/remote/sessions", dependencies=[Depends(loopback_only)])
def delete_sessions():
    remote.revoke_all()
    return remote.status()
