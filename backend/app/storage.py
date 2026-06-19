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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


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

    # Decode to learn dimensions + normalize mime/extension.
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        width, height = img.size
        if img.format:
            mime = Image.MIME.get(img.format, mime)
    except (UnidentifiedImageError, OSError):
        raise ValueError("Unsupported or corrupt image file")

    ext = _EXT.get(mime, "png")
    file_path = db.IMAGES_DIR / f"{sha}.{ext}"
    thumb_path = db.THUMBS_DIR / f"{sha}.webp"

    file_path.write_bytes(data)
    _make_thumb(img, thumb_path)

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


def _make_thumb(img: Image.Image, thumb_path) -> None:
    thumb = img.copy()
    thumb.thumbnail((THUMB_MAX, THUMB_MAX))
    if thumb.mode not in ("RGB", "RGBA"):
        thumb = thumb.convert("RGBA")
    thumb.save(thumb_path, format="WEBP", quality=82)
