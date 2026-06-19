"""Image upload, listing, file serving, metadata edit, delete."""
import io
import zipfile

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response

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
    q: str | None = None,
):
    clauses, params = ["deleted_at IS NULL"], []
    if source:
        clauses.append("source = ?")
        params.append(source)
    if starred is not None:
        clauses.append("starred = ?")
        params.append(1 if starred else 0)
    if tag is not None:
        clauses.append("id IN (SELECT image_id FROM image_tags WHERE tag_id = ?)")
        params.append(tag)
    if q and q.strip():
        like = f"%{q.strip()}%"
        clauses.append(
            "(filename LIKE ? OR id IN ("
            "SELECT it.image_id FROM image_tags it "
            "JOIN tags t ON t.id = it.tag_id WHERE t.name LIKE ?))"
        )
        params.extend([like, like])
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


@router.get("/batch-download")
def batch_download(ids: str = Query(...)):
    id_list = [int(x) for x in ids.split(",") if x.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail="No valid ids provided")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        with get_conn() as conn:
            for image_id in id_list:
                row = storage.get_image(conn, image_id)
                if not row:
                    continue
                path = storage.file_on_disk(row)
                if not path.exists():
                    continue
                zf.write(path, f"{image_id}_{row['filename']}")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=images.zip"},
    )


@router.get("/bin")
def list_bin(
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List images currently in the recycle bin (most recently deleted first)."""
    sql = (
        "SELECT * FROM images WHERE deleted_at IS NOT NULL "
        "ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?"
    )
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(sql, (limit, offset)).fetchall()]
        tagging.attach_tags(conn, rows)
        total = conn.execute(
            "SELECT COUNT(*) c FROM images WHERE deleted_at IS NOT NULL"
        ).fetchone()["c"]
    return {"images": rows, "total": total}


@router.post("/bin/empty")
def empty_bin():
    """Permanently delete every image currently in the recycle bin."""
    with get_conn() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM images WHERE deleted_at IS NOT NULL"
            ).fetchall()
        ]
        for row in rows:
            _purge(conn, row)
        conn.commit()
    return {"purged": len(rows)}


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
    path = storage.file_on_disk(row, thumb=col == "thumb_path")
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
    """Soft-delete: move the image to the recycle bin. Always allowed — the
    row and files stay on disk so any generation lineage keeps rendering it as
    'deleted'. Restore or permanently purge it from the bin."""
    with get_conn() as conn:
        if not storage.get_image(conn, image_id):
            raise HTTPException(status_code=404, detail="Image not found")
        conn.execute(
            "UPDATE images SET deleted_at = ? WHERE id = ?",
            (storage._now(), image_id),
        )
        conn.commit()
    return {"deleted": image_id}


@router.post("/{image_id}/restore")
def restore_image(image_id: int):
    """Bring a soft-deleted image back out of the recycle bin."""
    with get_conn() as conn:
        if not storage.get_image(conn, image_id):
            raise HTTPException(status_code=404, detail="Image not found")
        conn.execute(
            "UPDATE images SET deleted_at = NULL WHERE id = ?", (image_id,)
        )
        conn.commit()
        return storage.get_image(conn, image_id)


@router.delete("/{image_id}/purge")
def purge_image(image_id: int):
    """Permanently delete an image: detach it from any generation lineage,
    drop the row + files. History keeps the generation row (output becomes a
    'deleted' placeholder); purged input slots simply disappear."""
    with get_conn() as conn:
        row = storage.get_image(conn, image_id)
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        _purge(conn, row)
        conn.commit()
    return {"purged": image_id}


def _purge(conn, row) -> None:
    """Detach lineage/tags, delete the images row, and unlink its files."""
    image_id = row["id"]
    conn.execute(
        "UPDATE generations SET output_image_id = NULL WHERE output_image_id = ?",
        (image_id,),
    )
    conn.execute("DELETE FROM generation_inputs WHERE image_id = ?", (image_id,))
    conn.execute("DELETE FROM image_tags WHERE image_id = ?", (image_id,))
    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    # Best-effort file cleanup (resolve by basename within current data dir).
    for thumb in (False, True):
        try:
            storage.file_on_disk(row, thumb=thumb).unlink(missing_ok=True)
        except OSError:
            pass
