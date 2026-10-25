"""Desktop shell bridge: local client state, activity numbers, and the long-poll
the menubar icon uses to stay in step with the backend.

Loopback only: these routes are mounted in the desktop build alone and 404 on
the LAN listener, exactly like the remote-access management routes.
"""
import asyncio
import time
from typing import Literal

from fastapi import APIRouter, Depends, Query
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
# Upper bound for one long-poll hold. The shell asks for 25 s and keeps a 15 s
# fallback poll, so a lost wake-up costs at most one fallback interval.
MAX_WAIT_S = 30.0

_client = {"queued": 0, "running": 0, "lang": None, "at": 0.0}


def _activity() -> dict:
    fresh = _client["at"] > 0 and time.monotonic() - _client["at"] < CLIENT_TTL_S
    return {
        "generating": remote.generating_total(),
        "queued_local": _client["queued"] if fresh else 0,
        "lang": _client["lang"],
    }


def _snapshot() -> dict:
    # Read the revision before building the payload: a change that lands while
    # we compute makes the shell's next wait return immediately instead of
    # sleeping through a missed notification.
    revision = remote.revision()
    return {
        "revision": revision,
        "status": remote.status(),
        "activity": _activity(),
    }


class ClientState(BaseModel):
    queued: int = Field(default=0, ge=0)
    running: int = Field(default=0, ge=0)
    lang: Literal["zh", "en"] | None = None


@router.put("/client")
def put_client(body: ClientState):
    """Frontend queue snapshot. Memory only; no state survives a restart."""
    before = _activity()
    _client["queued"] = body.queued
    _client["running"] = body.running
    if body.lang:
        _client["lang"] = body.lang
    _client["at"] = time.monotonic()
    # Heartbeats repeat the same numbers every 10 s; only a visible change should
    # wake the long-poll (a report arriving after expiry changes it back).
    if _activity() != before:
        remote.bump_revision()
    return {"ok": True}


@router.get("/activity")
def activity():
    return _activity()


@router.get("/wait")
async def wait(
    since: int = Query(0, ge=0),
    timeout: float = Query(25.0, ge=0, le=MAX_WAIT_S),
):
    """Long-poll: return the tray snapshot as soon as the revision moves.

    One request is held open for at most ``timeout`` seconds. Time-based
    changes (a device going idle, a queue report aging out) are not revision
    bumps; the shell's slow fallback poll covers those.
    """
    if remote.revision() == since:
        await asyncio.to_thread(remote.wait_for_revision, since, timeout)
    return await asyncio.to_thread(_snapshot)
