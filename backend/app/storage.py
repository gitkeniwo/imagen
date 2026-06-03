"""Image file persistence: sha256 dedup, thumbnails, DB rows."""
import hashlib
import io
from datetime import datetime, timezone
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


def store_image(conn, data: bytes, filename: str, mime: str, source: str) -> dict:
    """Persist image bytes (dedup by sha256) and return the images row as a dict.

    If an identical image already exists, the existing row is returned unchanged.
    """
    sha = hashlib.sha256(data).hexdigest()

    existing = conn.execute(
        "SELECT * FROM images WHERE sha256 = ?", (sha,)
    ).fetchone()
    if existing:
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
