"""Generation history with lineage (input images + output image)."""
from fastapi import APIRouter, HTTPException, Query

from .. import tagging
from ..db import get_conn

router = APIRouter(prefix="/api/generations", tags=["generations"])


def _inputs_for(conn, gen_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT i.* FROM generation_inputs gi
           JOIN images i ON i.id = gi.image_id
           WHERE gi.generation_id = ?
           ORDER BY gi.position""",
        (gen_id,),
    ).fetchall()
    return tagging.attach_tags(conn, [dict(r) for r in rows])


def _output_for(conn, output_image_id) -> dict | None:
    if not output_image_id:
        return None
    row = conn.execute(
        "SELECT * FROM images WHERE id = ?", (output_image_id,)
    ).fetchone()
    if not row:
        return None
    return tagging.attach_tags(conn, [dict(row)])[0]


@router.get("")
def list_generations(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
    tag: int | None = None,
    q: str | None = None,
    starred: bool | None = None,
):
    # Filter by the output image's tag (i.e. generations archived into that tag),
    # by a substring of the prompt, and/or by whether the output is starred
    # (the "favorites" / saved-prompt view).
    clauses, params = [], []
    if tag is not None:
        clauses.append(
            "output_image_id IN "
            "(SELECT image_id FROM image_tags WHERE tag_id = ?)"
        )
        params.append(tag)
    if starred:
        clauses.append(
            "output_image_id IN "
            "(SELECT id FROM images WHERE starred = 1 AND deleted_at IS NULL)"
        )
    if q and q.strip():
        clauses.append("prompt LIKE ?")
        params.append(f"%{q.strip()}%")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with get_conn() as conn:
        gens = conn.execute(
            f"SELECT * FROM generations {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) c FROM generations {where}", params
        ).fetchone()["c"]
        out = []
        for g in gens:
            g = dict(g)
            g["inputs"] = _inputs_for(conn, g["id"])
            g["outputImage"] = _output_for(conn, g["output_image_id"])
            out.append(g)
    return {"generations": out, "total": total}


@router.get("/by-output/{image_id}")
def generation_by_output(image_id: int):
    """The most recent generation that produced this output image, or null.
    Lets the image lightbox surface the prompt behind a generated image."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE output_image_id = ? "
            "ORDER BY id DESC LIMIT 1",
            (image_id,),
        ).fetchone()
        if not row:
            return None
        g = dict(row)
        g["inputs"] = _inputs_for(conn, g["id"])
        g["outputImage"] = _output_for(conn, g["output_image_id"])
    return g


@router.get("/{gen_id}")
def get_generation(gen_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ?", (gen_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Generation not found")
        g = dict(row)
        g["inputs"] = _inputs_for(conn, gen_id)
        g["outputImage"] = _output_for(conn, g["output_image_id"])
    return g
