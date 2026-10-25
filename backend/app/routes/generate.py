"""Generation entry point: assemble inputs, call Gemini, persist lineage."""
import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import gemini, remote, storage, tagging
from ..db import get_conn
from ..models import GenerateRequest
from ..remote_gate import is_lan
from .settings import read_vertex

router = APIRouter(prefix="/api", tags=["generate"])
logger = logging.getLogger("imagen.generate")
_MARKER_COLORS = {"red", "orange", "yellow", "green", "blue", "purple", "pink"}

# WebKit drops idle HTTP responses at ~61 s (stage-0 spike), and a real Vertex
# call can stay silent for minutes, so /api/generate streams a keep-alive space
# before the result. Whitespace is valid leading JSON, so `res.json()` in the
# frontend needs no change.
KEEPALIVE_INTERVAL_S = 15.0

# Strong references to the detached generation tasks. Starlette cancels the
# response generator when the client disconnects, so the work must live in its
# own task; without this set the event loop could garbage-collect it mid-flight.
_ACTIVE_TASKS: set[asyncio.Task] = set()

# Ephemeral, best-effort live progress per client queue-task id (set by the
# frontend as clientTaskId). Holds the latest gemini event ({"phase": ...}) so
# the UI can poll while a request is in flight. Not durable: cleared when the
# request settles and lost on restart — mirrors the client's in-memory queue.
PROGRESS: dict[str, dict] = {}

# Client task ids the user asked to cancel. The in-flight /api/generate request
# keeps reading this (via should_abort) and stops retrying cooperatively, then
# returns its real final result — so the request stays open and the frontend
# learns the true outcome (success-kept / aborted) instead of a closed socket.
CANCELLED: set[str] = set()

# Client task ids with an open /api/generate request. Cancel signals are only
# accepted for these — otherwise a cancel for an already-finished (or never
# started) task would sit in CANCELLED forever.
INFLIGHT: set[str] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("/generate/progress/{cid}")
def generate_progress(cid: str):
    """Latest in-flight phase for a queue task (sent / retrying / unknown)."""
    return PROGRESS.get(cid) or {"phase": "unknown"}


@router.post("/generate/cancel/{cid}")
def cancel_generate(cid: str):
    """Signal a running generation to stop retrying (cooperative cancel)."""
    if cid not in INFLIGHT:
        return {"ok": False}
    CANCELLED.add(cid)
    return {"ok": True}


def _payload(
    status: str,
    message: str | None,
    text: str | None,
    generation: dict | None,
    output_image: dict | None,
    input_ids: list[int],
) -> dict:
    return {
        "status": status,
        "message": message,
        "text": text,
        "generation": generation,
        "outputImage": output_image,
        "inputImageIds": input_ids,
    }


@router.post("/generate")
async def generate(body: GenerateRequest, request: Request):
    """Run one generation and stream its result.

    Validation, the Vertex project check and input existence checks all happen
    before the response starts, so failures still return plain 4xx JSON. The
    success path is a StreamingResponse: the heavy work runs in a detached task
    (strong-referenced in ``_ACTIVE_TASKS``) while this generator emits a
    keep-alive space every 15 s and finally the same JSON body as before.
    """
    project, location = read_vertex()
    if not project:
        raise HTTPException(status_code=400, detail="Vertex project not set. Please enter your Project ID in Settings.")
    model = gemini.normalize_model(body.model)
    if body.markerColor is not None and body.markerColor not in _MARKER_COLORS:
        raise HTTPException(status_code=400, detail="Invalid marker color")

    # Ordered, de-duplicated input image ids: library refs first, then uploads.
    ordered_ids: list[int] = []
    for i in [*body.inputImageIds, *body.uploadImageIds]:
        if i not in ordered_ids:
            ordered_ids.append(i)

    # Resolve rows first (fast DB reads); the file reads happen off the event
    # loop so a batch of large inputs can't stall concurrent requests.
    input_rows: list[dict] = []
    with get_conn() as conn:
        for img_id in ordered_ids:
            row = storage.get_image(conn, img_id)
            if not row:
                raise HTTPException(status_code=404, detail=f"Input image {img_id} does not exist.")
            input_rows.append(row)

    def _read_inputs() -> list[gemini.InputImage]:
        return [
            gemini.InputImage(data=storage.file_on_disk(r).read_bytes(), mime=r["mime"])
            for r in input_rows
        ]

    input_images = await asyncio.to_thread(_read_inputs)

    # Persist a History placeholder only once the request is ready to be sent.
    # Pending client-side queue items never reach this endpoint, so they remain
    # session-only. A crash/closed window can no longer lose the task prompt.
    def _create_running() -> int:
        with get_conn() as conn:
            cur = conn.execute(
                """INSERT INTO generations
                   (prompt, model, aspect_ratio, resolution, status, error_message,
                    raw_finish, output_image_id, created_at, source,
                    client_task_id, marker_color)
                   VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, 'vertex', ?, ?)""",
                (body.prompt, model, body.aspectRatio, body.resolution, _now(),
                 body.clientTaskId, body.markerColor),
            )
            gen_id = cur.lastrowid
            for pos, img_id in enumerate(ordered_ids):
                conn.execute(
                    "INSERT INTO generation_inputs (generation_id, image_id, position) "
                    "VALUES (?, ?, ?)",
                    (gen_id, img_id, pos),
                )
            return gen_id

    gen_id = await asyncio.to_thread(_create_running)

    # Cooperative cancel: stop signal comes from POST /generate/cancel/{cid}
    # (CANCELLED) — the request stays open so we can return the true result.
    # A client disconnect is the fallback (tab closed / the window navigated
    # away): StreamingResponse cancels this generator, which sets the flag
    # below. gemini.generate checks should_abort at retry boundaries, so it
    # finishes the current in-flight attempt (keeping a completed/billable
    # result) but skips all further retries. The work task is NEVER cancelled
    # on disconnect — it must run to completion so the history row is honest.
    cid = body.clientTaskId
    disconnected = {"v": False}
    # iPad Safari drops long connections when the tab goes to the background;
    # that must not stop the retries. LAN requests only cancel explicitly.
    lan = is_lan(request.scope)
    owner = remote.session_started(request.scope["state"].get("remote_session")) if lan else None

    def on_event(ev: dict) -> None:
        if cid:
            PROGRESS[cid] = ev

    def _should_abort() -> bool:
        return disconnected["v"] or bool(cid and cid in CANCELLED)

    # Persist in a worker thread (Pillow decode + thumbnail are CPU-bound and
    # would otherwise stall the event loop). The thread opens its own
    # connection — sqlite3 connections are bound to their creating thread.
    def _persist(result: gemini.GeminiResult, explicitly_cancelled: bool) -> tuple[str, str | None, dict | None, dict | None]:
        status, message = result.status, result.message
        output_image = None
        with get_conn() as conn:
            if explicitly_cancelled and result.status != "success":
                conn.execute("DELETE FROM generations WHERE id = ?", (gen_id,))
                return "aborted", "User cancelled.", None, None
            if result.status == "aborted":
                status = "error"
                message = "Client disconnected before a response was stored."
            if result.status == "success":
                try:
                    ext = "jpg" if (result.image_mime or "").endswith("jpeg") else "png"
                    output_image = storage.store_image(
                        conn, result.image_bytes, f"gen-{_now()}.{ext}",
                        result.image_mime or "image/png", source="generated",
                    )
                except Exception as e:  # noqa: BLE001
                    # The (billable) call succeeded but we couldn't keep the
                    # bytes — still record the generation so history is honest.
                    status = "error"
                    message = f"Image generated but could not be stored: {e}"

            conn.execute(
                """UPDATE generations
                   SET status = ?, error_message = ?, raw_finish = ?, output_image_id = ?
                   WHERE id = ?""",
                (status, message,
                 "CLIENT_DISCONNECTED" if result.status == "aborted" else result.raw_finish,
                 output_image["id"] if output_image else None, gen_id),
            )
            # Auto-archive into chosen tags only on success: output + input images.
            if body.tagIds and output_image:
                targets = [*ordered_ids, output_image["id"]]
                tagging.apply_tags(conn, targets, body.tagIds)
            conn.commit()
            if output_image:
                tagging.attach_tags(conn, [output_image])
            generation = dict(
                conn.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
            )
        return status, message, generation, output_image

    async def _run_generation() -> dict:
        """Detached worker: call Gemini, persist the row, return the payload.

        Runs in its own task so a client disconnect (which cancels the response
        generator) does not cancel the generation. Never raises: any crash is
        turned into a valid `status="error"` payload so the stream can always
        finish with parseable JSON.
        """
        try:
            result = await gemini.generate(
                project=project,
                location=location,
                prompt=body.prompt,
                model=model,
                aspect_ratio=body.aspectRatio,
                resolution=body.resolution,
                images=input_images,
                output_mime=body.outputFormat,
                on_event=on_event,
                should_abort=_should_abort,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — last-resort guard for the row
            logger.exception("generation task crashed (gen_id=%s)", gen_id)
            result = gemini.GeminiResult(
                status="error", message=f"Unexpected backend error: {exc}"
            )

        explicitly_cancelled = bool(cid and cid in CANCELLED)
        try:
            status, message, generation, output_image = await asyncio.to_thread(
                _persist, result, explicitly_cancelled
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("failed to persist generation (gen_id=%s)", gen_id)
            status, message, output_image = "error", f"Failed to store result: {exc}", None
            try:
                with get_conn() as conn:
                    conn.execute(
                        "UPDATE generations SET status = 'error', error_message = ? WHERE id = ?",
                        (message, gen_id),
                    )
                    conn.commit()
                    generation = dict(
                        conn.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
                    )
            except Exception:  # noqa: BLE001
                generation = None

        try:
            text = result.text
        except Exception:  # noqa: BLE001
            text = None
        return _payload(status, message, text, generation, output_image, ordered_ids)

    async def _run() -> dict:
        """Own the lifecycle sets: they must clear even if the response was
        cancelled and nobody is left to read the payload."""
        try:
            return await _run_generation()
        finally:
            remote.generation_finished()
            if owner is not None:
                remote.session_finished(owner)
            if cid:
                INFLIGHT.discard(cid)
                PROGRESS.pop(cid, None)
                CANCELLED.discard(cid)

    # Counted only here: every earlier return is a 4xx validation failure that
    # never reaches Vertex. Paired with generation_finished() in _run's finally,
    # so success, error, block and cancel all decrement exactly once.
    remote.generation_started()
    if cid:
        INFLIGHT.add(cid)
    task = asyncio.create_task(_run())
    _ACTIVE_TASKS.add(task)
    task.add_done_callback(_ACTIVE_TASKS.discard)

    async def _stream():
        try:
            yield b" "  # flush headers/first byte immediately
            while True:
                done, _ = await asyncio.wait({task}, timeout=KEEPALIVE_INTERVAL_S)
                if task in done:
                    break
                yield b" "
        except (asyncio.CancelledError, GeneratorExit):
            # Starlette cancels this generator when the client goes away. Detect
            # the disconnect here (request.is_disconnected() is unreliable once
            # the response has started) and let the work task stop cooperatively
            # at its next retry boundary. The task itself is left running.
            if not lan:
                disconnected["v"] = True
            raise

        if task.cancelled():
            payload = _payload(
                "error", "Generation was cancelled.", None, None, None, ordered_ids
            )
        else:
            try:
                payload = task.result()
            except Exception as exc:  # noqa: BLE001
                logger.exception("generation task raised (gen_id=%s)", gen_id)
                payload = _payload(
                    "error", f"Unexpected backend error: {exc}", None, None, None, ordered_ids
                )
        yield json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")

    # No `finally` cleanup here: the work task owns INFLIGHT/PROGRESS/CANCELLED
    # so they stay accurate even when this response is cancelled mid-stream.
    return StreamingResponse(_stream(), media_type="application/json")
