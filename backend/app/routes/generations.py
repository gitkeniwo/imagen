"""Generation history with lineage (input images + output image)."""
from fastapi import APIRouter, HTTPException, Query

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
    return [dict(r) for r in rows]


def _output_for(conn, output_image_id) -> dict | None:
    if not output_image_id:
        return None
    row = conn.execute(
        "SELECT * FROM images WHERE id = ?", (output_image_id,)
    ).fetchone()
    return dict(row) if row else None


@router.get("")
def list_generations(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    with get_conn() as conn:
        gens = conn.execute(
            "SELECT * FROM generations ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) c FROM generations").fetchone()["c"]
        out = []
        for g in gens:
            g = dict(g)
            g["inputs"] = _inputs_for(conn, g["id"])
            g["outputImage"] = _output_for(conn, g["output_image_id"])
            out.append(g)
    return {"generations": out, "total": total}


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
