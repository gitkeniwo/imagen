"""Image upload, listing, file serving, metadata edit, delete."""
import asyncio
import os
import re
import tempfile
import zipfile
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from .. import storage, tagging
from ..db import GENERATION_SORT_AT, get_conn
from ..models import ImagePatch
from ..timeline import MAX_IDS_LIMIT, query_timeline

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
    return {"images": storage.public_images(out)}


def _library_where(
    source: str | None,
    starred: bool | None,
    tag: int | None,
    q: str | None,
) -> tuple[str, list]:
    """WHERE clause shared by the library list, timeline and ids endpoints.

    Every endpoint that describes "the current Library result" must build its
    filter here, so positions (offset / first_index) always agree.
    """
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
    return f"WHERE {' AND '.join(clauses)}", params


# The list order. Timeline positions are ROW_NUMBER() over this same order.
_LIBRARY_ORDER = "id DESC"


@router.get("")
def list_images(
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    source: str | None = None,
    starred: bool | None = None,
    tag: int | None = None,
    q: str | None = None,
):
    where, params = _library_where(source, starred, tag, q)
    sql = (
        f"SELECT * FROM images {where} "
        f"ORDER BY {_LIBRARY_ORDER} LIMIT ? OFFSET ?"
    )
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(sql, (*params, limit, offset)).fetchall()]
        tagging.attach_tags(conn, rows)
        total = conn.execute(
            f"SELECT COUNT(*) c FROM images {where}", params
        ).fetchone()["c"]
    return {"images": storage.public_images(rows), "total": total}


@router.get("/timeline")
def images_timeline(
    source: str | None = None,
    starred: bool | None = None,
    tag: int | None = None,
    q: str | None = None,
    tz: int = Query(0, ge=-1440, le=1440),
):
    """Per-day counts for the Library scrubber / jump dialog.

    ``first_index`` is the 0-based position of the day's first image in the
    list order (same filters as ``GET /api/images``). It is computed with a
    window function, because ``created_at`` is not guaranteed to follow id
    order (imported / migrated rows), so a day may be scattered through the
    list. ``tz`` is minutes east of UTC. Rows whose ``created_at`` is missing
    or unparseable are grouped under ``"unknown"``.

    ``runs`` answers "which day is at position i": ``[start_index, day]`` for
    every position where the day differs from the previous position, in list
    order (the first entry always starts at 0). ``first_index`` alone cannot
    answer it: one stray imported row puts its day's ``first_index`` in the
    middle of another day's images.
    """
    where, params = _library_where(source, starred, tag, q)
    return query_timeline(
        source="images",
        where=where,
        params=params,
        order=_LIBRARY_ORDER,
        date_expr="date(created_at, ?)",
        tz=tz,
    )


@router.get("/ids")
def list_image_ids(
    offset: int = Query(0, ge=0),
    limit: int = Query(MAX_IDS_LIMIT, ge=1, le=MAX_IDS_LIMIT),
    source: str | None = None,
    starred: bool | None = None,
    tag: int | None = None,
    q: str | None = None,
):
    """Ids only, same filters and order as the list (range / select-all)."""
    where, params = _library_where(source, starred, tag, q)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT id FROM images {where} ORDER BY {_LIBRARY_ORDER} LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) c FROM images {where}", params
        ).fetchone()["c"]
    return {"ids": [r["id"] for r in rows], "total": total}


MAX_LOOKUP_IDS = 50


@router.get("/lookup")
def lookup_images(ids: str = Query(...)):
    """Fetch live image rows by id, in the order requested.

    Used to restore a composer draft: ids of deleted/purged images simply drop
    out. Declared before the ``/{image_id}/...`` routes so "lookup" is not
    parsed as an image id.
    """
    raw = ids.split(",")
    if (
        not raw
        or len(raw) > MAX_LOOKUP_IDS
        or any(not (part.isascii() and part.isdigit()) or int(part) <= 0 for part in raw)
    ):
        raise HTTPException(
            status_code=400,
            detail=f"ids must be 1-{MAX_LOOKUP_IDS} comma-separated positive integers",
        )
    id_list = [int(part) for part in raw]
    placeholders = ",".join("?" * len(id_list))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM images WHERE deleted_at IS NULL AND id IN ({placeholders})",
            id_list,
        ).fetchall()
        by_id = {row["id"]: dict(row) for row in rows}
        images = [by_id[image_id] for image_id in id_list if image_id in by_id]
        tagging.attach_tags(conn, images)
    return {"images": storage.public_images(images)}


@router.get("/batch-download")
def batch_download(ids: str = Query(...)):
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be comma-separated integers")
    if not id_list:
        raise HTTPException(status_code=400, detail="No valid ids provided")
    # Build the archive on disk (system temp dir), not in memory: holding the
    # whole ZIP in a BytesIO cost ~2x the selected originals. Images are
    # already compressed, so ZIP_STORED skips pointless deflate CPU.
    tmp = tempfile.NamedTemporaryFile(prefix="imagen-batch-", suffix=".zip", delete=False)
    tmp_path = tmp.name
    try:
        with tmp, zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
            with get_conn() as conn:
                for image_id in id_list:
                    row = storage.get_image(conn, image_id)
                    if not row:
                        continue
                    path = storage.file_on_disk(row)
                    if not path.exists():
                        continue
                    # download_name drops directory parts, so a crafted upload
                    # name like "../../x" cannot escape the folder on unzip.
                    zf.write(path, f"{image_id}_{download_name(row)}")
    except BaseException:
        os.unlink(tmp_path)
        raise
    # BackgroundTask runs after the response finishes or the client disconnects.
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        headers={
            "Content-Disposition": "attachment; filename=images.zip",
            "Cache-Control": "private, no-store",
        },
        background=BackgroundTask(os.unlink, tmp_path),
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
    return {"images": storage.public_images(rows), "total": total}


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


DERIVED_PROMPT_CHARS = 200


@router.get("/{image_id}/derived")
def derived_generations(
    image_id: int,
    limit: int = Query(24, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Generations that used this image as an input (reverse lineage).

    Newest first. Every outcome is listed (blocked / error / running rows have
    no output); an output in the bin is returned with its ``deleted_at`` set so
    the viewer can mark it. Legacy note rows stay hidden, as in History.
    """
    with get_conn() as conn:
        if not storage.get_image(conn, image_id):
            raise HTTPException(status_code=404, detail="Image not found")
        where = (
            "FROM generations g WHERE g.status != 'note' AND g.id IN "
            "(SELECT generation_id FROM generation_inputs WHERE image_id = ?)"
        )
        total = conn.execute(f"SELECT COUNT(*) c {where}", (image_id,)).fetchone()["c"]
        rows = [
            dict(r)
            for r in conn.execute(
                f"""SELECT g.id, g.status, g.prompt, g.model, g.provider, g.source,
                           g.error_message, g.raw_finish, g.created_at, g.output_image_id
                    {where}
                    ORDER BY {GENERATION_SORT_AT} DESC, g.id DESC
                    LIMIT ? OFFSET ?""",
                (image_id, limit, offset),
            ).fetchall()
        ]
        output_ids = sorted({r["output_image_id"] for r in rows if r["output_image_id"]})
        outputs: dict[int, dict] = {}
        if output_ids:
            ph = ",".join("?" * len(output_ids))
            outputs = {
                r["id"]: dict(r)
                for r in conn.execute(
                    f"SELECT * FROM images WHERE id IN ({ph})", output_ids
                ).fetchall()
            }
            tagging.attach_tags(conn, list(outputs.values()))
    items = []
    for r in rows:
        prompt = r["prompt"] or ""
        output = outputs.get(r["output_image_id"])
        items.append({
            "id": r["id"],
            "status": r["status"],
            "prompt": prompt[:DERIVED_PROMPT_CHARS],
            "promptTruncated": len(prompt) > DERIVED_PROMPT_CHARS,
            "model": r["model"],
            "provider": r["provider"],
            "source": r["source"],
            "error_message": r["error_message"],
            "raw_finish": r["raw_finish"],
            "created_at": r["created_at"],
            "outputImage": storage.public_image(output) if output else None,
        })
    return {"generations": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{image_id}/file")
def get_file(image_id: int, request: Request):
    return _serve(image_id, "file_path", request)


@router.get("/{image_id}/thumb")
def get_thumb(image_id: int, request: Request):
    return _serve(image_id, "thumb_path", request)


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
_GENERATED_NAME = re.compile(
    r"^gen-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$"
)


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

    if (row.get("source") or "") == "generated":
        match = _GENERATED_NAME.match(stem)
        if match:
            try:
                stamp = datetime.fromisoformat(match.group(1)).replace(tzinfo=timezone.utc)
                return f"imagen-{stamp.astimezone():%Y%m%d-%H%M%S}.{ext}"
            except ValueError:
                pass

    valid = _EXT_ALIASES.get(ext, {ext})
    if suffix in valid:
        name = raw
    elif dot > 0:
        name = f"{stem}.{ext}"
    else:
        name = f"{raw}.{ext}"
    return name.replace(":", "-")


def _serve(image_id: int, col: str, request: Request):
    with get_conn() as conn:
        row = storage.get_image(conn, image_id)
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb = col == "thumb_path"
    path = storage.file_on_disk(row, thumb=thumb)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    # IDs restart at 1 in every library and the desktop origin never changes,
    # so a cached /api/images/7/thumb from one library used to show up in the
    # next one. The frontend now adds ?v=<sha256 prefix>: such a URL names
    # exactly these bytes, so it may be cached for good (a phone keeps working
    # through a dropped connection). Anything else must revalidate against a
    # content-derived ETag. A revoked LAN device gets 401 from every list
    # endpoint and is sent to /login, so it can no longer browse the library.
    v = request.query_params.get("v", "")
    if len(v) >= 16 and row["sha256"].startswith(v):
        cache = "private, max-age=31536000, immutable"
    else:
        cache = "private, no-cache"
    etag = f'"{row["sha256"]}-t{path.stat().st_size}"' if thumb else f'"{row["sha256"]}"'
    headers = {"Cache-Control": cache, "ETag": etag}
    if etag in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers=headers)
    if thumb:
        # Thumbnails are always WebP (storage._make_thumb), regardless of the
        # original image's MIME type.
        return FileResponse(path, media_type="image/webp", headers=headers)
    filename = download_name(row)
    headers["Content-Disposition"] = f"inline; filename*=UTF-8''{quote(filename, safe='')}"
    return FileResponse(path, media_type=row["mime"], headers=headers)


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
        return storage.public_image(storage.get_image(conn, image_id))


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
        return storage.public_image(storage.get_image(conn, image_id))


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
    # A purged series "best" pick falls back to the newest success (the FK is
    # ON DELETE SET NULL too; this keeps it explicit like the lines above).
    conn.execute(
        "UPDATE series SET best_image_id = NULL WHERE best_image_id = ?", (image_id,)
    )
    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    # Best-effort file cleanup (resolve by basename within current data dir).
    for thumb in (False, True):
        try:
            storage.file_on_disk(row, thumb=thumb).unlink(missing_ok=True)
        except OSError:
            pass
