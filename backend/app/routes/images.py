"""Image upload, listing, file serving, metadata edit, delete."""
import asyncio
import io
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response

from .. import storage, tagging
from ..db import get_conn
from ..models import ImagePatch

router = APIRouter(prefix="/api/images", tags=["images"])


@router.post("")
async def upload_images(files: list[UploadFile] = File(...)):
    """Upload one or more images. Returns the stored image rows (deduped)."""
    payloads = []
    for f in files:
        data = await f.read()
        if data:
            payloads.append((data, f.filename or "upload", f.content_type or "image/png"))

    # Pillow decode + thumbnailing is CPU-bound — run off the event loop. The
    # thread opens its own connection (sqlite3 conns are thread-bound).
    def _store() -> list[dict]:
        out = []
        with get_conn() as conn:
            for data, name, mime in payloads:
                out.append(storage.store_image(conn, data, name, mime, source="upload"))
            tagging.attach_tags(conn, out)
        return out

    try:
        out = await asyncio.to_thread(_store)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
    # "generated" is every output image (imported results flip their output to
    # generated); "app" / "imported" split it by the record that produced it.
    gen_source = {"app": "vertex", "imported": "manual"}.get(source or "")
    if gen_source:
        clauses.append(
            "id IN (SELECT output_image_id FROM generations "
            "WHERE source = ? AND output_image_id IS NOT NULL)"
        )
        params.append(gen_source)
    elif source:
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
        "ORDER BY id DESC LIMIT ? OFFSET ?"
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
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be comma-separated integers")
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


# Canonical extension for the MIME types storage accepts, plus one alias so a
# stored `photo.jpeg` keeps its existing (valid) extension.
_MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
_EXT_ALIASES = {"jpg": {"jpg", "jpeg"}}


def download_name(row: dict) -> str:
    """Return a safe, user-facing filename consistent with the image's MIME.

    Generated images are stored as ``gen-<ISO timestamp>.jpg``; the colons in
    the timestamp are replaced because they are awkward in Finder and in
    Content-Disposition headers. The database value is never modified.
    """
    mime = (row.get("mime") or "").lower()
    ext = _MIME_EXT.get(mime, "png")
    raw = (row.get("filename") or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    raw = "".join(ch for ch in raw if ch >= " " and ch != "\x7f")
    if not raw or raw in (".", ".."):
        return f"imagen-{row['id']}.{ext}"

    dot = raw.rfind(".")
    if dot > 0:
        stem, suffix = raw[:dot], raw[dot + 1:].lower()
    else:
        stem, suffix = raw, ""

    valid = _EXT_ALIASES.get(ext, {ext})
    if suffix in valid:
        name = raw
    elif dot > 0:
        name = f"{stem}.{ext}"
    else:
        name = f"{raw}.{ext}"
    return name.replace(":", "-")


def _serve(image_id: int, col: str):
    with get_conn() as conn:
        row = storage.get_image(conn, image_id)
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    path = storage.file_on_disk(row, thumb=col == "thumb_path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    if col == "thumb_path":
        # Thumbnails are always WebP (storage._make_thumb), regardless of the
        # original image's MIME type.
        return FileResponse(path, media_type="image/webp")
    filename = download_name(row)
    return FileResponse(
        path,
        media_type=row["mime"],
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename, safe='')}"
        },
    )


@router.patch("/{image_id}")
def patch_image(image_id: int, body: ImagePatch):
    sets, params = [], []
    if body.starred is not None:
        sets.append("starred = ?")
        params.append(1 if body.starred else 0)
    if body.filename is not None:
        sets.append("filename = ?")
        params.append(body.filename)
    if body.note is not None:
        # Empty string clears the note (not "no change").
        sets.append("note = ?")
        params.append(body.note or None)
    if body.source is not None:
        if body.source not in ("upload", "generated"):
            raise HTTPException(status_code=400, detail=f"Invalid source: {body.source}")
        sets.append("source = ?")
        params.append(body.source)
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
