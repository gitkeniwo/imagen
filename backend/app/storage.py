"""Image file persistence: sha256 dedup, thumbnails, DB rows."""
import hashlib
import io
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from PIL import Image, UnidentifiedImageError

from . import db

THUMB_MAX = 384  # longest edge of thumbnail in px

# Map common mime types to file extensions for stored originals.
_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


# Local filesystem locations are backend-only. They are still needed inside the
# app (file serving, purge, backups), but every API response must use
# ``public_image`` so a library path never reaches a browser — including the
# owner's. The frontend builds URLs from an image id.
_PRIVATE_IMAGE_COLUMNS = ("file_path", "thumb_path")


def public_image(row) -> dict:
    """Return an image row without local filesystem paths, for API responses."""
    data = _row_to_dict(row) if hasattr(row, "keys") else dict(row)
    for column in _PRIVATE_IMAGE_COLUMNS:
        data.pop(column, None)
    return data


def public_images(rows) -> list[dict]:
    return [public_image(row) for row in rows]


def get_image(conn, image_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    return _row_to_dict(row) if row else None


def file_on_disk(row, thumb: bool = False) -> Path:
    """On-disk path for an image's original (or thumbnail), resolved by basename
    within the *current* data dir.

    The DB may hold absolute paths from another host/mount (the data dir gets
    moved or bind-mounted into a container at a different prefix), so we never
    trust the stored prefix — only the ``<sha>.<ext>`` filename, which is stable.
    """
    base = db.THUMBS_DIR if thumb else db.IMAGES_DIR
    col = "thumb_path" if thumb else "file_path"
    return base / Path(row[col]).name


def store_image(conn, data: bytes, filename: str, mime: str, source: str) -> dict:
    """Persist image bytes (dedup by sha256) and return the images row as a dict.

    If an identical image already exists, the existing row is returned unchanged.
    """
    sha = hashlib.sha256(data).hexdigest()

    existing = conn.execute(
        "SELECT * FROM images WHERE sha256 = ?", (sha,)
    ).fetchone()
    if existing:
        # Re-adding an image that's sitting in the recycle bin restores it.
        if existing["deleted_at"] is not None:
            conn.execute(
                "UPDATE images SET deleted_at = NULL WHERE id = ?", (existing["id"],)
            )
            conn.commit()
            return get_image(conn, existing["id"])
        return _row_to_dict(existing)

    # Read dimensions + mime from the header, then build the thumbnail straight
    # from the unloaded image. For JPEG, Pillow's thumbnail() uses draft() to
    # decode at reduced scale, so the full-resolution bitmap is never held. The
    # decode still walks the whole stream, so it doubles as the corruption check
    # and runs before anything is written to disk. Only the formats we store are
    # tried: Pillow's other plugins include EPS, which shells out to Ghostscript,
    # and uploads are untrusted bytes.
    try:
        img = Image.open(io.BytesIO(data), formats=_FORMATS)
        width, height = img.size
        if img.format:
            mime = Image.MIME.get(img.format, mime)
        thumb = _make_thumb(img)
    except (UnidentifiedImageError, OSError):
        raise ValueError("Unsupported or corrupt image file")

    ext = _EXT.get(mime, "png")
    file_path = db.IMAGES_DIR / f"{sha}.{ext}"
    thumb_path = db.THUMBS_DIR / f"{sha}.webp"

    file_path.write_bytes(data)
    thumb.save(thumb_path, format="WEBP", quality=82)

    cur = conn.execute(
        """INSERT INTO images
           (sha256, filename, mime, width, height, byte_size, source,
            file_path, thumb_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (sha, filename, mime, width, height, len(data), source,
         str(file_path), str(thumb_path), _now()),
    )
    conn.commit()
    return get_image(conn, cur.lastrowid)


def _make_thumb(img: Image.Image) -> Image.Image:
    """Downscale in place (no full-size copy) and return an RGB/RGBA image."""
    img.thumbnail((THUMB_MAX, THUMB_MAX))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    return img
