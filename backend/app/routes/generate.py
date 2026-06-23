"""Generation entry point: assemble inputs, call Gemini, persist lineage."""
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from .. import gemini, storage, tagging
from ..db import get_conn
from ..models import GenerateRequest
from .settings import read_vertex

router = APIRouter(prefix="/api", tags=["generate"])

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("/generate/progress/{cid}")
def generate_progress(cid: str):
    """Latest in-flight phase for a queue task (sent / retrying / unknown)."""
    return PROGRESS.get(cid) or {"phase": "unknown"}


@router.post("/generate/cancel/{cid}")
def cancel_generate(cid: str):
    """Signal a running generation to stop retrying (cooperative cancel)."""
    CANCELLED.add(cid)
    return {"ok": True}


@router.post("/generate")
async def generate(body: GenerateRequest, request: Request):
    project, location = read_vertex()
    if not project:
        raise HTTPException(status_code=400, detail="Vertex project not set. Please enter your Project ID in Settings.")

    # Ordered, de-duplicated input image ids: library refs first, then uploads.
    ordered_ids: list[int] = []
    for i in [*body.inputImageIds, *body.uploadImageIds]:
        if i not in ordered_ids:
            ordered_ids.append(i)

    input_images: list[gemini.InputImage] = []
    with get_conn() as conn:
        for img_id in ordered_ids:
            row = storage.get_image(conn, img_id)
            if not row:
                raise HTTPException(status_code=404, detail=f"Input image {img_id} does not exist.")
            data = storage.file_on_disk(row).read_bytes()
            input_images.append(gemini.InputImage(data=data, mime=row["mime"]))

    # Cooperative cancel: stop signal comes from POST /generate/cancel/{cid}
    # (CANCELLED) — the request stays open so we can return the true result.
    # A disconnect watcher is the fallback (tab closed / navigated away).
    # gemini.generate checks should_abort at retry boundaries, so it finishes
    # the current in-flight attempt (keeping a completed/billable result) but
    # skips all further retries.
    cid = body.clientTaskId
    disconnected = {"v": False}

    def on_event(ev: dict) -> None:
        if cid:
            PROGRESS[cid] = ev

    async def _watch() -> None:
        try:
            while not await request.is_disconnected():
                await asyncio.sleep(0.3)
            disconnected["v"] = True
        except asyncio.CancelledError:
            pass

    watch_task = asyncio.ensure_future(_watch())
    try:
        result = await gemini.generate(
            project=project,
            location=location,
            prompt=body.prompt,
            model=body.model,
            aspect_ratio=body.aspectRatio,
            resolution=body.resolution,
            images=input_images,
            output_mime=body.outputFormat,
            on_event=on_event,
            should_abort=lambda: disconnected["v"] or (cid in CANCELLED),
        )
    finally:
        watch_task.cancel()
        if cid:
            PROGRESS.pop(cid, None)
            CANCELLED.discard(cid)

    output_image = None
    with get_conn() as conn:
        if result.status == "success":
            ext = "jpg" if (result.image_mime or "").endswith("jpeg") else "png"
            output_image = storage.store_image(
                conn, result.image_bytes, f"gen-{_now()}.{ext}",
                result.image_mime or "image/png", source="generated",
            )

        cur = conn.execute(
            """INSERT INTO generations
               (prompt, model, aspect_ratio, resolution, status, error_message,
                raw_finish, output_image_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.prompt, body.model, body.aspectRatio, body.resolution,
             result.status, result.message, result.raw_finish,
             output_image["id"] if output_image else None, _now()),
        )
        gen_id = cur.lastrowid
        for pos, img_id in enumerate(ordered_ids):
            conn.execute(
                "INSERT INTO generation_inputs (generation_id, image_id, position) "
                "VALUES (?, ?, ?)",
                (gen_id, img_id, pos),
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

    return {
        "status": result.status,
        "message": result.message,
        "text": result.text,
        "generation": generation,
        "outputImage": output_image,
        "inputImageIds": ordered_ids,
    }
