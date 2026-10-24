"""Desktop shell bridge: local client state and the activity numbers the
menubar icon and quit guard need.

Loopback only: these routes are mounted in the desktop build alone and 404 on
the LAN listener, exactly like the remote-access management routes.
"""
import time
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import remote
from .remote import loopback_only

router = APIRouter(
    prefix="/api/desktop",
    tags=["desktop"],
    dependencies=[Depends(loopback_only)],
)

# The local frontend re-reports at least every 10 s; anything older means the
# app page is gone (error page, reload, closed window) and its queue is gone
# with it.
CLIENT_TTL_S = 20.0

_client = {"queued": 0, "running": 0, "lang": None, "at": 0.0}


class ClientState(BaseModel):
    queued: int = Field(default=0, ge=0)
    running: int = Field(default=0, ge=0)
    lang: Literal["zh", "en"] | None = None


@router.put("/client")
def put_client(body: ClientState):
    """Frontend queue snapshot. Memory only; no state survives a restart."""
    _client["queued"] = body.queued
    _client["running"] = body.running
    if body.lang:
        _client["lang"] = body.lang
    _client["at"] = time.monotonic()
    return {"ok": True}


@router.get("/activity")
def activity():
    fresh = _client["at"] > 0 and time.monotonic() - _client["at"] < CLIENT_TTL_S
    return {
        "generating": remote.generating_total(),
        "queued_local": _client["queued"] if fresh else 0,
        "lang": _client["lang"],
    }
