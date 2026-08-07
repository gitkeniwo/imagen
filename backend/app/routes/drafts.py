"""Persistent generation-task drafts."""
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from .. import tagging
from ..db import get_conn
from ..models import DraftCreate, DraftUpdate

router = APIRouter(prefix="/api/drafts", tags=["drafts"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unique(ids: list[int]) -> list[int]:
    return list(dict.fromkeys(ids))


def _validate_refs(conn, image_ids: list[int], tag_ids: list[int]) -> None:
    for image_id in _unique(image_ids):
        if not conn.execute("SELECT 1 FROM images WHERE id = ?", (image_id,)).fetchone():
            raise HTTPException(status_code=404, detail=f"Image {image_id} does not exist.")
    for tag_id in _unique(tag_ids):
        if not conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone():
            raise HTTPException(status_code=404, detail=f"Tag {tag_id} does not exist.")


def _replace_images(conn, draft_id: int, role: str, image_ids: list[int]) -> None:
    conn.execute("DELETE FROM draft_images WHERE draft_id = ? AND role = ?", (draft_id, role))
    for position, image_id in enumerate(_unique(image_ids)):
        conn.execute(
            "INSERT INTO draft_images (draft_id, image_id, role, position) VALUES (?, ?, ?, ?)",
            (draft_id, image_id, role, position),
        )


def _replace_tags(conn, draft_id: int, tag_ids: list[int]) -> None:
    conn.execute("DELETE FROM draft_tags WHERE draft_id = ?", (draft_id,))
    for tag_id in _unique(tag_ids):
        conn.execute(
            "INSERT INTO draft_tags (draft_id, tag_id) VALUES (?, ?)",
            (draft_id, tag_id),
        )


def _hydrate(conn, drafts: list[dict]) -> list[dict]:
    if not drafts:
        return drafts
    ids = [d["id"] for d in drafts]
    ph = ",".join("?" * len(ids))
    image_rows = conn.execute(
        f"""SELECT di.draft_id, di.role, di.position, i.*
            FROM draft_images di JOIN images i ON i.id = di.image_id
            WHERE di.draft_id IN ({ph})
            ORDER BY di.draft_id, di.role, di.position""",
        ids,
    ).fetchall()
    images_by_draft: dict[int, dict[str, list[dict]]] = {}
    all_images: list[dict] = []
    for row in image_rows:
        item = dict(row)
        draft_id = item.pop("draft_id")
        role = item.pop("role")
        item.pop("position")
        images_by_draft.setdefault(draft_id, {"input": [], "output": []})[role].append(item)
        all_images.append(item)
    tagging.attach_tags(conn, all_images)

    tag_rows = conn.execute(
        f"""SELECT dt.draft_id, t.id, t.name, t.color
            FROM draft_tags dt JOIN tags t ON t.id = dt.tag_id
            WHERE dt.draft_id IN ({ph}) ORDER BY t.name""",
        ids,
    ).fetchall()
    tags_by_draft: dict[int, list[dict]] = {}
    for row in tag_rows:
        tags_by_draft.setdefault(row["draft_id"], []).append(
            {"id": row["id"], "name": row["name"], "color": row["color"]}
        )

    for draft in drafts:
        grouped = images_by_draft.get(draft["id"], {"input": [], "output": []})
        draft["inputImages"] = grouped["input"]
        draft["outputImages"] = grouped["output"]
        draft["tags"] = tags_by_draft.get(draft["id"], [])
    return drafts


def _get(conn, draft_id: int) -> dict:
    row = conn.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Draft not found")
    return _hydrate(conn, [dict(row)])[0]


@router.get("")
def list_drafts(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str | None = None,
    pinned: bool | None = None,
):
    clauses: list[str] = []
    params: list[object] = []
    if q and q.strip():
        clauses.append("prompt LIKE ?")
        params.append(f"%{q.strip()}%")
    if pinned is not None:
        clauses.append("pinned = ?")
        params.append(1 if pinned else 0)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT * FROM drafts {where}
                ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?""",
            (*params, limit, offset),
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) c FROM drafts {where}", params
        ).fetchone()["c"]
        drafts = _hydrate(conn, [dict(row) for row in rows])
    return {"drafts": drafts, "total": total}


@router.get("/{draft_id}")
def get_draft(draft_id: int):
    with get_conn() as conn:
        return _get(conn, draft_id)


@router.post("")
def create_draft(body: DraftCreate):
    now = _now()
    input_ids = _unique(body.inputImageIds)
    output_ids = _unique(body.outputImageIds)
    tag_ids = _unique(body.tagIds)
    with get_conn() as conn:
        _validate_refs(conn, [*input_ids, *output_ids], tag_ids)
        cur = conn.execute(
            """INSERT INTO drafts
               (prompt, model, aspect_ratio, resolution, output_format,
                skip_if_preceding_succeeds, pinned, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.prompt, body.model, body.aspectRatio, body.resolution,
             body.outputFormat, int(body.skipIfPrecedingSucceeds), int(body.pinned),
             now, now),
        )
        draft_id = cur.lastrowid
        _replace_images(conn, draft_id, "input", input_ids)
        _replace_images(conn, draft_id, "output", output_ids)
        _replace_tags(conn, draft_id, tag_ids)
        return _get(conn, draft_id)


@router.patch("/{draft_id}")
def update_draft(draft_id: int, body: DraftUpdate):
    data = body.model_dump(exclude_unset=True)
    with get_conn() as conn:
        _get(conn, draft_id)
        input_ids = data.get("inputImageIds")
        output_ids = data.get("outputImageIds")
        tag_ids = data.get("tagIds")
        _validate_refs(
            conn,
            [*(input_ids or []), *(output_ids or [])],
            tag_ids or [],
        )
        column_map = {
            "prompt": "prompt",
            "model": "model",
            "aspectRatio": "aspect_ratio",
            "resolution": "resolution",
            "outputFormat": "output_format",
            "skipIfPrecedingSucceeds": "skip_if_preceding_succeeds",
            "pinned": "pinned",
        }
        sets: list[str] = []
        params: list[object] = []
        for key, column in column_map.items():
            if key in data:
                value = data[key]
                if key in {"skipIfPrecedingSucceeds", "pinned"}:
                    value = int(value)
                sets.append(f"{column} = ?")
                params.append(value)
        sets.append("updated_at = ?")
        params.append(_now())
        conn.execute(
            f"UPDATE drafts SET {', '.join(sets)} WHERE id = ?",
            (*params, draft_id),
        )
        if input_ids is not None:
            _replace_images(conn, draft_id, "input", input_ids)
        if output_ids is not None:
            _replace_images(conn, draft_id, "output", output_ids)
        if tag_ids is not None:
            _replace_tags(conn, draft_id, tag_ids)
        return _get(conn, draft_id)


@router.delete("/{draft_id}")
def delete_draft(draft_id: int):
    with get_conn() as conn:
        _get(conn, draft_id)
        conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    return {"deleted": draft_id}
