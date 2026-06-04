"""Tag CRUD + batch image membership (add/remove)."""
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from .. import tagging
from ..db import get_conn
from ..models import BatchTag, TagCreate, TagUpdate

router = APIRouter(prefix="/api/tags", tags=["tags"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tag_row(conn, tag_id: int) -> dict | None:
    row = conn.execute(
        """SELECT t.*,
                  (SELECT COUNT(*) FROM image_tags it WHERE it.tag_id = t.id) AS count
           FROM tags t WHERE t.id = ?""",
        (tag_id,),
    ).fetchone()
    return dict(row) if row else None


@router.get("")
def list_tags():
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT t.*,
                      (SELECT COUNT(*) FROM image_tags it WHERE it.tag_id = t.id) AS count
               FROM tags t
               ORDER BY t.name COLLATE NOCASE"""
        ).fetchall()
    return {"tags": [dict(r) for r in rows]}


@router.post("")
def create_tag(body: TagCreate):
    """Create a tag, or return the existing one if the name is taken."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tag name required")
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)",
                (name, body.color, _now()),
            )
            conn.commit()
            tag_id = cur.lastrowid
        except sqlite3.IntegrityError:
            existing = conn.execute(
                "SELECT id FROM tags WHERE name = ?", (name,)
            ).fetchone()
            tag_id = existing["id"]
        return _tag_row(conn, tag_id)


@router.patch("/{tag_id}")
def update_tag(tag_id: int, body: TagUpdate):
    sets, params = [], []
    if body.name is not None:
        sets.append("name = ?")
        params.append(body.name.strip())
    if body.color is not None:
        sets.append("color = ?")
        params.append(body.color)
    if body.coverImageId is not None:
        sets.append("cover_image_id = ?")
        params.append(body.coverImageId)
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    with get_conn() as conn:
        if not _tag_row(conn, tag_id):
            raise HTTPException(status_code=404, detail="Tag not found")
        try:
            conn.execute(
                f"UPDATE tags SET {', '.join(sets)} WHERE id = ?", (*params, tag_id)
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Tag name already exists")
        return _tag_row(conn, tag_id)


@router.delete("/{tag_id}")
def delete_tag(tag_id: int):
    """Delete a tag. Images are untouched; only memberships are removed (cascade)."""
    with get_conn() as conn:
        if not _tag_row(conn, tag_id):
            raise HTTPException(status_code=404, detail="Tag not found")
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        conn.commit()
    return {"deleted": tag_id}


@router.post("/batch")
def batch(body: BatchTag):
    """Add or remove a set of tags across a set of images."""
    if not body.imageIds or not body.tagIds:
        return {"updated": 0}
    with get_conn() as conn:
        if body.op == "remove":
            tagging.remove_tags(conn, body.imageIds, body.tagIds)
        else:
            tagging.apply_tags(conn, body.imageIds, body.tagIds)
        conn.commit()
    return {"updated": len(body.imageIds) * len(body.tagIds), "op": body.op}
