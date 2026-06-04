"""Shared helpers for image<->tag membership (many-to-many, idempotent)."""
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def apply_tags(conn, image_ids, tag_ids) -> None:
    """Add (image, tag) memberships. Idempotent union via INSERT OR IGNORE."""
    now = _now()
    for img in image_ids:
        for tag in tag_ids:
            conn.execute(
                "INSERT OR IGNORE INTO image_tags (image_id, tag_id, created_at) "
                "VALUES (?, ?, ?)",
                (img, tag, now),
            )


def remove_tags(conn, image_ids, tag_ids) -> None:
    for img in image_ids:
        for tag in tag_ids:
            conn.execute(
                "DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?",
                (img, tag),
            )


def tags_for_images(conn, image_ids) -> dict[int, list[dict]]:
    """Map image_id -> [{id, name, color}, ...]."""
    image_ids = list(image_ids)
    if not image_ids:
        return {}
    placeholders = ",".join("?" * len(image_ids))
    rows = conn.execute(
        f"""SELECT it.image_id, t.id, t.name, t.color
            FROM image_tags it JOIN tags t ON t.id = it.tag_id
            WHERE it.image_id IN ({placeholders})
            ORDER BY t.name""",
        tuple(image_ids),
    ).fetchall()
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["image_id"], []).append(
            {"id": r["id"], "name": r["name"], "color": r["color"]}
        )
    return out


def attach_tags(conn, image_rows: list[dict]) -> list[dict]:
    """Mutate each image dict to include its `tags` list."""
    by_id = tags_for_images(conn, [r["id"] for r in image_rows])
    for r in image_rows:
        r["tags"] = by_id.get(r["id"], [])
    return image_rows
