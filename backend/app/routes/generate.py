"""Generation entry point: assemble inputs, call Gemini, persist lineage."""
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from .. import gemini, storage, tagging
from ..db import get_conn
from ..models import GenerateRequest
from .settings import read_vertex

router = APIRouter(prefix="/api", tags=["generate"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _watch_disconnect(request: Request) -> None:
    """Resolve once the client closes the connection (e.g. user hit cancel)."""
    while not await request.is_disconnected():
        await asyncio.sleep(0.3)


@router.post("/generate")
async def generate(body: GenerateRequest, request: Request):
    project, location = read_vertex()
    if not project:
        raise HTTPException(status_code=400, detail="尚未设置 Vertex 项目，请先在设置中填写 Project ID。")

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
                raise HTTPException(status_code=404, detail=f"输入图片 {img_id} 不存在。")
            data = Path(row["file_path"]).read_bytes()
            input_images.append(gemini.InputImage(data=data, mime=row["mime"]))

    # Race the generation against the client connection. If the client
    # disconnects (user pressed cancel / AbortController.abort), cancel the whole
    # generation coroutine — CancelledError unwinds every await point, including
    # the in-flight generate_content call and any retry/backoff sleep, so we stop
    # hammering Vertex (and stop future billable attempts). A generation Vertex
    # already finished may still be billed; disconnecting cannot un-charge it.
    gen_task = asyncio.ensure_future(
        gemini.generate(
            project=project,
            location=location,
            prompt=body.prompt,
            model=body.model,
            aspect_ratio=body.aspectRatio,
            resolution=body.resolution,
            images=input_images,
            output_mime=body.outputFormat,
        )
    )
    watch_task = asyncio.ensure_future(_watch_disconnect(request))
    done, _ = await asyncio.wait(
        {gen_task, watch_task}, return_when=asyncio.FIRST_COMPLETED
    )
    if gen_task in done:
        watch_task.cancel()
        result = gen_task.result()
    else:
        gen_task.cancel()
        try:
            await gen_task
        except asyncio.CancelledError:
            pass
        result = gemini.GeminiResult(
            status="aborted", message="用户取消生成。", raw_finish="ABORTED"
        )

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
