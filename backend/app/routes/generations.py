"""Generation history with lineage (input images + output image)."""

from fastapi import APIRouter, HTTPException, Query

from .. import providers, storage, tagging
from ..db import GENERATION_SORT_AT, canonical_timestamp, get_conn, now_timestamp
from ..models import ManualGenerationRequest, MarkerPatch

router = APIRouter(prefix="/api/generations", tags=["generations"])

_STATUSES = {"success", "blocked", "error"}
_SOURCES = {"vertex", "manual"}
_MARKER_COLORS = {"red", "orange", "yellow", "green", "blue", "purple", "pink"}
_LIVE_OUTPUT_CLAUSE = (
    "output_image_id IN (SELECT id FROM images WHERE deleted_at IS NULL)"
)
# History filter by outcome. "error" also covers cancelled requests, which the
# UI shows as failures too; "running" placeholders match no outcome filter.
_RESULT_FILTERS = {
    "success": ("success",),
    "blocked": ("blocked",),
    "error": ("error", "aborted"),
}
# Newest first by when the generation happened. Manual records may carry a
# past `created_at` with a larger id, so id only breaks ties. created_at is
# stored as canonical UTC ISO text (db.canonical_timestamp), so text order is
# time order; unparsable values and NULLs sort last (db.GENERATION_SORT_AT).
_SORT_AT = GENERATION_SORT_AT
_ORDER = f"{_SORT_AT} DESC, id DESC"


def _now() -> str:
    return now_timestamp()


def _inputs_for(conn, gen_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT i.* FROM generation_inputs gi
           JOIN images i ON i.id = gi.image_id
           WHERE gi.generation_id = ?
           ORDER BY gi.position""",
        (gen_id,),
    ).fetchall()
    return storage.public_images(
        tagging.attach_tags(conn, [dict(r) for r in rows])
    )


def _hydrate(conn, gens: list[dict]) -> list[dict]:
    """Attach `inputs` + `outputImage` to a page of generations with a fixed
    number of queries (inputs, outputs, tags) instead of 3+ per row."""
    if not gens:
        return gens
    gen_ids = [g["id"] for g in gens]
    ph = ",".join("?" * len(gen_ids))
    input_rows = conn.execute(
        f"""SELECT gi.generation_id AS gen_id, i.* FROM generation_inputs gi
            JOIN images i ON i.id = gi.image_id
            WHERE gi.generation_id IN ({ph})
            ORDER BY gi.generation_id, gi.position""",
        gen_ids,
    ).fetchall()
    inputs_by_gen: dict[int, list[dict]] = {}
    all_images: list[dict] = []
    for r in input_rows:
        d = dict(r)
        gen_id = d.pop("gen_id")
        inputs_by_gen.setdefault(gen_id, []).append(d)
        all_images.append(d)

    output_ids = [g["output_image_id"] for g in gens if g["output_image_id"]]
    outputs: dict[int, dict] = {}
    if output_ids:
        ph = ",".join("?" * len(output_ids))
        outputs = {
            r["id"]: dict(r)
            for r in conn.execute(
                f"SELECT * FROM images WHERE id IN ({ph})", output_ids
            ).fetchall()
        }
    all_images.extend(outputs.values())

    tagging.attach_tags(conn, all_images)
    for g in gens:
        g["inputs"] = storage.public_images(inputs_by_gen.get(g["id"], []))
        output = outputs.get(g["output_image_id"])
        g["outputImage"] = storage.public_image(output) if output else None
    return gens


def _output_for(conn, output_image_id) -> dict | None:
    if not output_image_id:
        return None
    row = conn.execute(
        "SELECT * FROM images WHERE id = ?", (output_image_id,)
    ).fetchone()
    if not row:
        return None
    return storage.public_image(tagging.attach_tags(conn, [dict(row)])[0])


def _validate_manual_body(body: ManualGenerationRequest) -> None:
    if body.status not in _STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")
    if body.source not in _SOURCES:
        raise HTTPException(status_code=400, detail=f"Invalid source: {body.source}")
    # History may belong to a provider that is off or not set up.
    if providers.get(body.provider) is None:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {body.provider}")
    if body.status == "success" and not body.outputImageId:
        # A success without an output renders as "deleted" in History.
        raise HTTPException(
            status_code=400, detail="A successful record needs an output image."
        )
    if body.createdAt:
        try:
            body.createdAt = canonical_timestamp(body.createdAt)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid createdAt: {body.createdAt}")


def _resolved_source(body: ManualGenerationRequest) -> str:
    return body.source


def _check_images_exist(conn, body: ManualGenerationRequest) -> None:
    from .series import require_leaf  # late import: series imports this module

    require_leaf(conn, body.seriesId)
    for img_id in [*body.inputImageIds, *([body.outputImageId] if body.outputImageId else [])]:
        if not storage.get_image(conn, img_id):
            raise HTTPException(status_code=404, detail=f"Image {img_id} does not exist.")


def _mark_output_generated(conn, output_image_id) -> None:
    # The output of a generation is a generated image — flip an uploaded image's
    # source so it's classified like a real Vertex result (it was uploaded with
    # source='upload' when logging the record manually).
    if output_image_id:
        conn.execute(
            "UPDATE images SET source = 'generated' WHERE id = ?", (output_image_id,)
        )


@router.post("/manual")
def create_manual_generation(body: ManualGenerationRequest):
    """Record a generation that happened elsewhere (no provider call) so it shows
    up in History alongside real generations."""
    _validate_manual_body(body)
    created_at = body.createdAt or _now()

    with get_conn() as conn:
        _check_images_exist(conn, body)

        cur = conn.execute(
            """INSERT INTO generations
               (prompt, model, aspect_ratio, resolution, status, error_message,
                raw_finish, output_image_id, created_at, source, provider, series_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.prompt, body.model, body.aspectRatio, body.resolution,
             body.status, body.errorMessage, None, body.outputImageId, created_at,
             _resolved_source(body), body.provider, body.seriesId),
        )
        gen_id = cur.lastrowid
        _mark_output_generated(conn, body.outputImageId)
        for pos, img_id in enumerate(body.inputImageIds):
            conn.execute(
                "INSERT INTO generation_inputs (generation_id, image_id, position) "
                "VALUES (?, ?, ?)",
                (gen_id, img_id, pos),
            )
        if body.tagIds:
            targets = [*body.inputImageIds, *([body.outputImageId] if body.outputImageId else [])]
            tagging.apply_tags(conn, targets, body.tagIds)
        conn.commit()

        row = conn.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
        g = dict(row)
        g["inputs"] = _inputs_for(conn, gen_id)
        g["outputImage"] = _output_for(conn, g["output_image_id"])
    return g


@router.patch("/{gen_id}")
def update_generation(gen_id: int, body: ManualGenerationRequest):
    """Edit any history record's fields (prompt, images, model, params,
    status/source, timestamp) in place — works for both manual and
    real-Vertex records. `raw_finish` (the original Vertex finish reason, if
    any) is left untouched."""
    _validate_manual_body(body)

    with get_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM generations WHERE id = ?", (gen_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Generation not found")

        _check_images_exist(conn, body)
        created_at = body.createdAt or existing["created_at"]

        conn.execute(
            """UPDATE generations
               SET prompt = ?, model = ?, aspect_ratio = ?, resolution = ?,
                   status = ?, error_message = ?, output_image_id = ?, created_at = ?,
                   source = ?, provider = ?
               WHERE id = ?""",
            (body.prompt, body.model, body.aspectRatio, body.resolution,
             body.status, body.errorMessage, body.outputImageId, created_at,
             _resolved_source(body), body.provider, gen_id),
        )
        if "seriesId" in body.model_fields_set:
            conn.execute(
                "UPDATE generations SET series_id = ? WHERE id = ?", (body.seriesId, gen_id)
            )
        _mark_output_generated(conn, body.outputImageId)
        conn.execute("DELETE FROM generation_inputs WHERE generation_id = ?", (gen_id,))
        for pos, img_id in enumerate(body.inputImageIds):
            conn.execute(
                "INSERT INTO generation_inputs (generation_id, image_id, position) "
                "VALUES (?, ?, ?)",
                (gen_id, img_id, pos),
            )
        if body.tagIds:
            targets = [*body.inputImageIds, *([body.outputImageId] if body.outputImageId else [])]
            tagging.apply_tags(conn, targets, body.tagIds)
        conn.commit()

        row = conn.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
        g = dict(row)
        g["inputs"] = _inputs_for(conn, gen_id)
        g["outputImage"] = _output_for(conn, g["output_image_id"])
    return g


@router.get("")
def list_generations(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
    tag: int | None = None,
    q: str | None = None,
    starred: bool | None = None,
    kind: str | None = None,
    status: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    with_output: bool = False,
    unique_outputs: bool = False,
    series: str | None = None,
):
    # Filter by the output image's tag (i.e. generations archived into that tag),
    # by a substring of the prompt, by whether the output is starred (the
    # "favorites" / saved-prompt view), and/or by record kind:
    # 'vertex' (real generation via this app), 'manual' (a logged result from
    # elsewhere. Legacy notes are preserved for rollback but no longer shown.
    base_clauses, params = ["status != 'note'"], []
    if tag is not None:
        base_clauses.append(
            "output_image_id IN "
            "(SELECT image_id FROM image_tags WHERE tag_id = ?)"
        )
        params.append(tag)
    if starred:
        base_clauses.append(
            "output_image_id IN "
            "(SELECT id FROM images WHERE starred = 1 AND deleted_at IS NULL)"
        )
    if kind == "vertex":
        base_clauses.append("source = ?")
        params.append("vertex")
    elif kind == "manual":
        base_clauses.append("source = ? AND status != ?")
        params.extend(["manual", "note"])
    if q and q.strip():
        base_clauses.append("prompt LIKE ?")
        params.append(f"%{q.strip()}%")
    if status:
        if status not in _RESULT_FILTERS:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
        wanted = _RESULT_FILTERS[status]
        base_clauses.append(f"status IN ({','.join('?' * len(wanted))})")
        params.extend(wanted)
    if model:
        # Old rows may still carry a preview id that maps to this model.
        wanted = providers.normalize_model(model)
        aliases = [wanted, *(a for a, m in providers.MODEL_ALIASES.items() if m == wanted)]
        base_clauses.append(f"model IN ({','.join('?' * len(aliases))})")
        params.extend(aliases)
    if provider:
        base_clauses.append("provider = ?")
        params.append(provider)
    if series:
        # "none" = not in any series; otherwise one series id.
        if series == "none":
            base_clauses.append("series_id IS NULL")
        else:
            try:
                base_clauses.append("series_id = ?")
                params.append(int(series))
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid series: {series}")
    clauses = [*base_clauses]
    if with_output or unique_outputs:
        # Only retain records with a live output image. This deliberately
        # excludes running, blocked, cancelled, failed, and deleted-output
        # records while remaining compatible with all other filters.
        clauses.append(_LIVE_OUTPUT_CLAUSE)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    base_where = f"WHERE {' AND '.join(base_clauses)}"
    output_where = f"WHERE {' AND '.join([*base_clauses, _LIVE_OUTPUT_CLAUSE])}"
    # The viewer navigates images, not generation records. Several records may
    # deliberately point at one output image (manual reuse or SHA-256 dedup),
    # so rank each live output by the newest matching generation that uses it
    # (newest in the same created_at/id order as the list itself).
    output_ranked = f"""
        SELECT output_image_id, representative_id, representative_at
        FROM (
            SELECT output_image_id, id AS representative_id,
                   {_SORT_AT} AS representative_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY output_image_id ORDER BY {_ORDER}
                   ) AS rn
            FROM generations
            {output_where}
        ) candidates
        WHERE rn = 1
    """
    output_positioned = f"""
        SELECT output_image_id, representative_id,
               ROW_NUMBER() OVER (
                   ORDER BY representative_at DESC, representative_id DESC
               ) - 1 AS output_index
        FROM ({output_ranked}) ranked
    """
    with get_conn() as conn:
        output_total = conn.execute(
            f"SELECT COUNT(*) c FROM ({output_ranked}) ranked", params
        ).fetchone()["c"]
        if unique_outputs:
            base_positioned = f"""
                SELECT id,
                       ROW_NUMBER() OVER (ORDER BY {_ORDER}) - 1 AS generation_offset
                FROM generations
                {base_where}
            """
            rows = conn.execute(
                f"""
                WITH output_positioned AS ({output_positioned}),
                     base_positioned AS ({base_positioned})
                SELECT g.*, b.generation_offset, p.output_index
                FROM output_positioned p
                JOIN generations g ON g.id = p.representative_id
                JOIN base_positioned b ON b.id = g.id
                ORDER BY p.output_index
                LIMIT ? OFFSET ?
                """,
                (*params, *params, limit, offset),
            ).fetchall()
            total = output_total
            output_offset = offset
            out = _hydrate(conn, [dict(g) for g in rows])
        else:
            gens = conn.execute(
                f"SELECT *, {_SORT_AT} AS sort_at FROM generations {where} "
                f"ORDER BY {_ORDER} LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
            total = conn.execute(
                f"SELECT COUNT(*) c FROM generations {where}", params
            ).fetchone()["c"]
            output_offset = 0
            if gens:
                # Everything whose newest matching generation is above this
                # grid page precedes its outputs in the viewer sequence.
                output_offset = conn.execute(
                    f"SELECT COUNT(*) c FROM ({output_ranked}) ranked "
                    "WHERE representative_at > ? "
                    "OR (representative_at = ? AND representative_id > ?)",
                    (*params, gens[0]["sort_at"], gens[0]["sort_at"], gens[0]["id"]),
                ).fetchone()["c"]
            out = _hydrate(conn, [
                {k: g[k] for k in g.keys() if k != "sort_at"} for g in gens
            ])
            for i, g in enumerate(out):
                g["generation_offset"] = offset + i
            output_ids = sorted({
                g["output_image_id"] for g in out if g["output_image_id"]
            })
            output_indexes: dict[int, int] = {}
            if output_ids:
                ph = ",".join("?" * len(output_ids))
                output_indexes = {
                    row["output_image_id"]: row["output_index"]
                    for row in conn.execute(
                        f"""
                        WITH output_positioned AS ({output_positioned})
                        SELECT output_image_id, output_index
                        FROM output_positioned
                        WHERE output_image_id IN ({ph})
                        """,
                        (*params, *output_ids),
                    ).fetchall()
                }
            for g in out:
                if g["output_image_id"]:
                    g["output_index"] = output_indexes.get(g["output_image_id"])
    return {
        "generations": out,
        "total": total,
        "output_total": output_total,
        "output_offset": output_offset,
    }


@router.get("/by-output/{image_id}")
def generation_by_output(image_id: int):
    """The most recent generation that produced this output image, or null.
    Lets the image lightbox surface the prompt behind a generated image."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE output_image_id = ? AND status != 'note' "
            f"ORDER BY {_ORDER} LIMIT 1",
            (image_id,),
        ).fetchone()
        if not row:
            return None
        g = dict(row)
        g["inputs"] = _inputs_for(conn, g["id"])
        g["outputImage"] = _output_for(conn, g["output_image_id"])
    return g


@router.patch("/by-client/{client_task_id}/marker")
def update_generation_marker(client_task_id: str, body: MarkerPatch):
    if body.markerColor is not None and body.markerColor not in _MARKER_COLORS:
        raise HTTPException(status_code=400, detail="Invalid marker color")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM generations WHERE client_task_id = ?", (client_task_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Generation not found")
        conn.execute(
            "UPDATE generations SET marker_color = ? WHERE id = ?",
            (body.markerColor, row["id"]),
        )
    return {"updated": row["id"], "markerColor": body.markerColor}


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
