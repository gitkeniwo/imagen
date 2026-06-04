"""Image upload, listing, file serving, metadata edit, delete."""
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from .. import storage, tagging
from ..db import get_conn
from ..models import ImagePatch

router = APIRouter(prefix="/api/images", tags=["images"])


@router.post("")
async def upload_images(files: list[UploadFile] = File(...)):
    """Upload one or more images. Returns the stored image rows (deduped)."""
    out = []
    with get_conn() as conn:
        for f in files:
            data = await f.read()
            if not data:
                continue
            try:
                row = storage.store_image(
                    conn, data, f.filename or "upload", f.content_type or "image/png",
                    source="upload",
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            out.append(row)
        tagging.attach_tags(conn, out)
    return {"images": out}


@router.get("")
def list_images(
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    source: str | None = None,
    starred: bool | None = None,
    tag: int | None = None,
):
    clauses, params = [], []
    if source:
        clauses.append("source = ?")
        params.append(source)
    if starred is not None:
        clauses.append("starred = ?")
        params.append(1 if starred else 0)
    if tag is not None:
        clauses.append("id IN (SELECT image_id FROM image_tags WHERE tag_id = ?)")
        params.append(tag)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        f"SELECT * FROM images {where} "
        "ORDER BY starred DESC, id DESC LIMIT ? OFFSET ?"
    )
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(sql, (*params, limit, offset)).fetchall()]
        tagging.attach_tags(conn, rows)
        total = conn.execute(
            f"SELECT COUNT(*) c FROM images {where}", params
        ).fetchone()["c"]
    return {"images": rows, "total": total}


@router.get("/{image_id}/file")
def get_file(image_id: int):
    return _serve(image_id, "file_path")


@router.get("/{image_id}/thumb")
def get_thumb(image_id: int):
    return _serve(image_id, "thumb_path")


def _serve(image_id: int, col: str):
    with get_conn() as conn:
        row = storage.get_image(conn, image_id)
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    path = Path(row[col])
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return FileResponse(path, media_type=row["mime"])


@router.patch("/{image_id}")
def patch_image(image_id: int, body: ImagePatch):
    sets, params = [], []
    if body.starred is not None:
        sets.append("starred = ?")
        params.append(1 if body.starred else 0)
    if body.filename is not None:
        sets.append("filename = ?")
        params.append(body.filename)
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    with get_conn() as conn:
        if not storage.get_image(conn, image_id):
            raise HTTPException(status_code=404, detail="Image not found")
        conn.execute(
            f"UPDATE images SET {', '.join(sets)} WHERE id = ?", (*params, image_id)
        )
        conn.commit()
        return storage.get_image(conn, image_id)


@router.delete("/{image_id}")
def delete_image(image_id: int):
    """Delete an image. Refuses if it is referenced by any generation
    (as input or output) to keep lineage intact."""
    with get_conn() as conn:
        row = storage.get_image(conn, image_id)
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        refs = conn.execute(
            "SELECT COUNT(*) c FROM generation_inputs WHERE image_id = ?", (image_id,)
        ).fetchone()["c"]
        refs += conn.execute(
            "SELECT COUNT(*) c FROM generations WHERE output_image_id = ?", (image_id,)
        ).fetchone()["c"]
        if refs:
            raise HTTPException(
                status_code=409,
                detail="Image is used by a generation; cannot delete.",
            )
        conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        conn.commit()
    # Best-effort file cleanup.
    for col in ("file_path", "thumb_path"):
        try:
            Path(row[col]).unlink(missing_ok=True)
        except OSError:
            pass
    return {"deleted": image_id}
