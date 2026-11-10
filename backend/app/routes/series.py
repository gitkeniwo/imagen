"""Series: two-level grouping (theme / series) of one line of iterative work.

A generation or draft belongs to at most one series (``series_id`` column, no
join table). Themes only group series; records always point at a leaf series.
Counting follows History and the usage dashboard: legacy ``status='note'``
rows are never counted, running placeholders are not attempts yet, and user
cancellations (``aborted``) are counted on their own and left out of the
success-rate denominator (#39).
"""
import re
import sqlite3

from fastapi import APIRouter, HTTPException, Query

from .. import series_marks, series_order, storage
from ..db import GENERATION_SORT_AT, get_conn, now_timestamp
from ..models import (
    SeriesAssign, SeriesCreate, SeriesImport, SeriesMarkClear, SeriesMarkUpdate,
    SeriesReorder, SeriesRestore, SeriesUpdate,
)
from .generations import _RESULT_FILTERS, _hydrate

router = APIRouter(prefix="/api/series", tags=["series"])

# Default colors, assigned round-robin by id when the client sends none.
PALETTE = [
    "#ea580c", "#0891b2", "#7c3aed", "#ca8a04", "#16a34a",
    "#db2777", "#2563eb", "#475569",
]
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
STRIP_LEN = 24   # recent statuses per series for the status bar
COVER_LEN = 3    # collage: best first, then newest successes
FILM_LEN = 200   # successful outputs listed on the detail page
_FINISHED = ("success", "blocked", "error", "aborted")
_SORT_G = GENERATION_SORT_AT.replace("created_at", "g.created_at")


def _clean_name(name: str | None) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise HTTPException(status_code=400, detail="Name required")
    if len(cleaned) > 120:
        raise HTTPException(status_code=400, detail="Name too long")
    return cleaned


def _clean_color(color: str | None) -> str | None:
    if color is None:
        return None
    if not _HEX.match(color):
        raise HTTPException(status_code=400, detail="Invalid color")
    return color.lower()


def _row(conn, series_id: int) -> dict:
    row = conn.execute("SELECT * FROM series WHERE id = ?", (series_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Series not found")
    return dict(row)


def require_leaf(conn, series_id: int | None) -> None:
    """4xx unless ``series_id`` is None or an existing kind='series' row."""
    if series_id is None:
        return
    row = conn.execute("SELECT kind FROM series WHERE id = ?", (series_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Series {series_id} does not exist.")
    if row["kind"] != "series":
        raise HTTPException(
            status_code=400, detail="Records can only belong to a series, not a theme."
        )


def _require_theme(conn, theme_id: int | None) -> None:
    if theme_id is None:
        return
    row = conn.execute("SELECT kind FROM series WHERE id = ?", (theme_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Theme {theme_id} does not exist.")
    if row["kind"] != "theme":
        raise HTTPException(status_code=400, detail="A series can only sit under a theme.")


def _name_taken(conn, kind: str, parent_id: int | None, name: str, exclude: int | None = None) -> bool:
    row = conn.execute(
        """SELECT id FROM series
           WHERE kind = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0)
             AND name = ? COLLATE NOCASE AND id != COALESCE(?, -1)""",
        (kind, parent_id, name, exclude),
    ).fetchone()
    return row is not None


def _free_name(conn, kind: str, parent_id: int | None, name: str) -> str:
    """``name``, or ``name (2)``, ``name (3)``… — first one free under parent."""
    if not _name_taken(conn, kind, parent_id, name):
        return name
    n = 2
    while _name_taken(conn, kind, parent_id, f"{name} ({n})"):
        n += 1
    return f"{name} ({n})"


def _insert(conn, kind: str, name: str, parent_id: int | None, color: str | None) -> int:
    if kind == "theme" and parent_id is not None:
        raise HTTPException(status_code=400, detail="A theme cannot have a parent.")
    if kind == "series":
        _require_theme(conn, parent_id)
    if _name_taken(conn, kind, parent_id, name):
        raise HTTPException(status_code=409, detail="name_taken")
    now = now_timestamp()
    if color is None:
        count = conn.execute("SELECT COUNT(*) c FROM series").fetchone()["c"]
        color = PALETTE[count % len(PALETTE)]
    try:
        cur = conn.execute(
            """INSERT INTO series (kind, parent_id, name, color, archived, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, ?, ?)""",
            (kind, parent_id, name, color, now, now),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="name_taken")
    return cur.lastrowid


# --- tree + statistics ------------------------------------------------------


def _empty_stats() -> dict:
    return {
        "tries": 0, "success": 0, "blocked": 0, "error": 0, "aborted": 0,
        "running": 0, "records": 0, "drafts": 0, "picks": 0, "last_at": None,
        "strip": [], "cover": [],
    }


def _stats(conn, ids: list[int] | None = None) -> dict[int, dict]:
    """Per-series counters, recent status strip and collage cover."""
    where, params = "series_id IS NOT NULL", []
    mark_where, mark_params = "1 = 1", []
    pick_where = "1 = 1"
    series_where, series_params = "", []
    if ids is not None:
        if not ids:
            return {}
        where = f"series_id IN ({','.join('?' * len(ids))})"
        mark_where = where
        pick_where = "sm.series_id IN (" + ",".join("?" * len(ids)) + ")"
        series_where = f"AND s.id IN ({','.join('?' * len(ids))})"
        params = list(ids)
        mark_params = list(ids)
        series_params = list(ids)
    out: dict[int, dict] = {}
    rows = conn.execute(
        f"""SELECT series_id, status, created_at FROM generations
            WHERE {where} AND status != 'note'
            ORDER BY {GENERATION_SORT_AT} ASC, id ASC""",
        params,
    ).fetchall()
    for r in rows:
        s = out.setdefault(r["series_id"], _empty_stats())
        s["records"] += 1
        st = r["status"]
        if st in _FINISHED:
            s["tries"] += 1
            s[st] += 1
            s["strip"].append(st)
        elif st == "running":
            s["running"] += 1
        if r["created_at"] and (s["last_at"] is None or r["created_at"] > s["last_at"]):
            s["last_at"] = r["created_at"]
    for s in out.values():
        s["strip"] = s["strip"][-STRIP_LEN:]

    for r in conn.execute(
        f"SELECT series_id, COUNT(*) c, MAX(updated_at) u FROM drafts WHERE {where} GROUP BY series_id",
        params,
    ).fetchall():
        s = out.setdefault(r["series_id"], _empty_stats())
        s["drafts"] = r["c"]

    for r in conn.execute(
        f"SELECT series_id, COUNT(*) c FROM series_marks "
        f"WHERE kind = 'pick' AND {mark_where} GROUP BY series_id",
        mark_params,
    ).fetchall():
        out.setdefault(r["series_id"], _empty_stats())["picks"] = r["c"]

    marks: dict[int, dict[int, str]] = {}
    for r in conn.execute(
        f"SELECT series_id, image_id, kind FROM series_marks WHERE {mark_where}",
        mark_params,
    ).fetchall():
        marks.setdefault(r["series_id"], {})[r["image_id"]] = r["kind"]

    # Cover fallback: explicit cover, else the latest pick, else the latest
    # successful output. Reject marks are never cover material. The rest of the
    # collage is the picks in series order, then newest successful outputs,
    # de-duplicated.
    for r in conn.execute(
        """SELECT s.id AS sid, i.* FROM series s
           JOIN images i ON i.id = s.best_image_id
           WHERE s.best_image_id IS NOT NULL AND i.deleted_at IS NULL """
        + series_where,
        series_params,
    ).fetchall():
        sid = r["sid"]
        if marks.get(sid, {}).get(r["id"]) == "reject":
            continue
        img = dict(r)
        img.pop("sid")
        out.setdefault(sid, _empty_stats())["cover"].append(storage.public_image(img))

    picks: dict[int, list[tuple[dict, str]]] = {}
    for r in conn.execute(
        f"""SELECT sm.series_id AS sid, sm.image_id AS image_id,
                   MIN(g.series_pos) AS series_pos, MIN(sm.created_at) AS marked_at, i.*
            FROM series_marks sm
            JOIN generations g ON g.series_id = sm.series_id
                              AND g.output_image_id = sm.image_id
                              AND g.status != 'note'
            JOIN images i ON i.id = sm.image_id
            WHERE sm.kind = 'pick' AND i.deleted_at IS NULL AND {pick_where}
            GROUP BY sm.series_id, sm.image_id
            ORDER BY sm.series_id, series_pos, sm.image_id""",
        mark_params,
    ).fetchall():
        img = dict(r)
        sid = img.pop("sid")
        img.pop("image_id")
        img.pop("series_pos")
        marked_at = img.pop("marked_at")
        picks.setdefault(sid, []).append((storage.public_image(img), marked_at or ""))

    for sid, images in picks.items():
        s = out.setdefault(sid, _empty_stats())
        if not s["cover"] and images:
            latest, _ = max(images, key=lambda item: (item[1], item[0]["id"]))
            s["cover"].append(latest)
        for img, _ in images:
            if len(s["cover"]) < COVER_LEN and all(c["id"] != img["id"] for c in s["cover"]):
                s["cover"].append(img)

    for r in conn.execute(
        f"""SELECT g.series_id AS sid, i.* FROM generations g
            JOIN images i ON i.id = g.output_image_id
            WHERE g.{where} AND g.status = 'success' AND i.deleted_at IS NULL
            ORDER BY {_SORT_G} DESC, g.id DESC""",
        params,
    ).fetchall():
        s = out.setdefault(r["sid"], _empty_stats())
        if len(s["cover"]) >= COVER_LEN:
            continue
        img = dict(r)
        img.pop("sid")
        if marks.get(r["sid"], {}).get(img["id"]) == "reject":
            continue
        if any(c["id"] == img["id"] for c in s["cover"]):
            continue
        s["cover"].append(storage.public_image(img))
    return out


def _node(row: dict, stats: dict | None) -> dict:
    node = dict(row)
    node.update(stats or _empty_stats())
    # best_* stays as a compatibility alias for one release.
    node["cover_image_id"] = node["best_image_id"]
    node["next_seq"] = node["records"] + 1
    return node


def _sum_theme(theme: dict, children: list[dict]) -> dict:
    agg = _empty_stats()
    for c in children:
        for k in (
            "tries", "success", "blocked", "error", "aborted", "running",
            "records", "drafts", "picks",
        ):
            agg[k] += c[k]
        if c["last_at"] and (agg["last_at"] is None or c["last_at"] > agg["last_at"]):
            agg["last_at"] = c["last_at"]
    # Theme collage: each series' first cover image (explicit cover or fallback).
    agg["cover"] = [c["cover"][0] for c in children if c["cover"]][:COVER_LEN]
    node = dict(theme)
    node.update(agg)
    node["cover_image_id"] = node["best_image_id"]
    node["series"] = children
    return node


def _activity_key(node: dict) -> str:
    return node.get("last_at") or node.get("updated_at") or ""


def _tree(conn, archived: str) -> dict:
    rows = [dict(r) for r in conn.execute("SELECT * FROM series ORDER BY id").fetchall()]
    stats = _stats(conn)
    themes = {r["id"]: r for r in rows if r["kind"] == "theme"}
    leaves = [_node(r, stats.get(r["id"])) for r in rows if r["kind"] == "series"]

    def visible_leaf(leaf: dict) -> bool:
        theme = themes.get(leaf["parent_id"])
        hidden = bool(leaf["archived"]) or bool(theme and theme["archived"])
        if archived == "1":
            return hidden
        if archived == "0":
            return not hidden
        return True

    by_theme: dict[int, list[dict]] = {}
    unthemed: list[dict] = []
    for leaf in leaves:
        if not visible_leaf(leaf):
            continue
        if leaf["parent_id"] in themes:
            by_theme.setdefault(leaf["parent_id"], []).append(leaf)
        else:
            unthemed.append(leaf)
    out_themes = []
    for tid, theme in themes.items():
        children = sorted(by_theme.get(tid, []), key=_activity_key, reverse=True)
        if archived == "1" and not theme["archived"] and not children:
            continue
        if archived == "0" and theme["archived"]:
            continue
        out_themes.append(_sum_theme(theme, children))
    out_themes.sort(key=_activity_key, reverse=True)
    unthemed.sort(key=_activity_key, reverse=True)
    return {"themes": out_themes, "unthemed": unthemed}


def _detail(conn, series_id: int) -> dict:
    row = _row(conn, series_id)
    if row["kind"] == "theme":
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM series WHERE parent_id = ? ORDER BY id", (series_id,)
            ).fetchall()
        ]
        stats = _stats(conn, [r["id"] for r in rows])
        children = [_node(r, stats.get(r["id"])) for r in rows]
        children.sort(key=_activity_key, reverse=True)
        return _sum_theme(row, children)
    node = _node(row, _stats(conn, [series_id]).get(series_id))
    node["theme"] = None
    if row["parent_id"]:
        theme = conn.execute(
            "SELECT id, name, color, archived FROM series WHERE id = ?", (row["parent_id"],)
        ).fetchone()
        node["theme"] = dict(theme) if theme else None
    # Every live successful output, oldest first, for the detail film strip.
    film = conn.execute(
        f"""SELECT g.id AS generation_id, i.* FROM generations g
            JOIN images i ON i.id = g.output_image_id
            WHERE g.series_id = ? AND g.status = 'success' AND i.deleted_at IS NULL
            ORDER BY {_SORT_G} ASC, g.id ASC
            LIMIT ?""",
        (series_id, FILM_LEN),
    ).fetchall()
    marks = series_marks.for_series(conn, series_id)
    node["outputs"] = []
    seen: set[int] = set()
    for r in film:
        img = dict(r)
        gid = img.pop("generation_id")
        if img["id"] in seen:
            continue
        seen.add(img["id"])
        public = storage.public_image(img)
        public["mark"] = marks.get(public["id"])
        node["outputs"].append({"generation_id": gid, "image": public})
    best = node["cover"][0] if node["cover"] else None
    node["best_image"] = best
    node["cover_image"] = best
    node["order_custom"] = series_order.order_custom(conn, series_id)
    return node


@router.get("")
def list_series(archived: str = Query("all", pattern="^(0|1|all)$")):
    """The theme → series tree with statistics.

    ``archived=0`` hides archived rows (a series under an archived theme counts
    as archived), ``archived=1`` shows only those, ``all`` (default) both.
    """
    with get_conn() as conn:
        return _tree(conn, archived)


@router.get("/membership")
def membership(image_ids: str = Query("", alias="imageIds")):
    """Map library images to the series of the generations that produced them.

    Uploads with no generation come back with ``generationIds: []`` so the UI
    can disable "Add to series" for them.
    """
    try:
        ids = [int(x) for x in image_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image ids")
    ids = list(dict.fromkeys(ids))[:500]
    items = {i: {"imageId": i, "generationIds": [], "seriesIds": []} for i in ids}
    if ids:
        with get_conn() as conn:
            for r in conn.execute(
                f"""SELECT id, output_image_id, series_id FROM generations
                    WHERE output_image_id IN ({','.join('?' * len(ids))})
                      AND status != 'note' ORDER BY id""",
                ids,
            ).fetchall():
                item = items[r["output_image_id"]]
                item["generationIds"].append(r["id"])
                if r["series_id"] is not None and r["series_id"] not in item["seriesIds"]:
                    item["seriesIds"].append(r["series_id"])
    return {"items": list(items.values())}


@router.get("/import/preview")
def import_preview(tag: int, include_failed: bool = False):
    with get_conn() as conn:
        return _import_plan(conn, tag, include_failed)["preview"]


def _import_plan(conn, tag_id: int, include_failed: bool) -> dict:
    if not conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Tag not found")
    tagged = conn.execute(
        """SELECT id, prompt, series_id FROM generations
           WHERE status != 'note' AND output_image_id IN
                 (SELECT image_id FROM image_tags WHERE tag_id = ?)""",
        (tag_id,),
    ).fetchall()
    ids = [r["id"] for r in tagged]
    extra: list[sqlite3.Row] = []
    prompts = sorted({r["prompt"] for r in tagged if r["prompt"]})
    if prompts:
        ph = ",".join("?" * len(prompts))
        candidates = conn.execute(
            f"""SELECT id, prompt, series_id FROM generations
                WHERE status IN ('blocked', 'error', 'aborted') AND prompt IN ({ph})""",
            prompts,
        ).fetchall()
        taken = set(ids)
        extra = [r for r in candidates if r["id"] not in taken]
    chosen = [*tagged, *(extra if include_failed else [])]
    return {
        "ids": [r["id"] for r in chosen],
        "preview": {
            "tagId": tag_id,
            "found": len(tagged),
            "inOtherSeries": sum(1 for r in tagged if r["series_id"] is not None),
            "failedSamePrompt": len(extra),
            "failedInOtherSeries": sum(1 for r in extra if r["series_id"] is not None),
            "total": len(chosen),
        },
    }


@router.post("/import")
def import_from_tag(body: SeriesImport):
    """Create a series from the generations whose output carries a tag."""
    name = _clean_name(body.name)
    color = _clean_color(body.color)
    with get_conn() as conn:
        plan = _import_plan(conn, body.tagId, body.includeFailed)
        series_id = _insert(conn, "series", name, body.parentId, color)
        _assign(conn, series_id, plan["ids"], [])
        detail = _detail(conn, series_id)
    return {"series": detail, "assigned": len(plan["ids"]), "preview": plan["preview"]}


@router.post("")
def create_series(body: SeriesCreate):
    name = _clean_name(body.name)
    color = _clean_color(body.color)
    with get_conn() as conn:
        series_id = _insert(conn, body.kind, name, body.parentId, color)
        return _detail(conn, series_id)


@router.get("/{series_id}")
def get_series(series_id: int):
    with get_conn() as conn:
        return _detail(conn, series_id)


@router.patch("/{series_id}")
def update_series(series_id: int, body: SeriesUpdate):
    fields = body.model_fields_set
    with get_conn() as conn:
        row = _row(conn, series_id)
        sets: dict[str, object] = {}
        name = row["name"]
        parent_id = row["parent_id"]
        if "name" in fields:
            name = _clean_name(body.name)
            sets["name"] = name
        if "parentId" in fields:
            if row["kind"] == "theme":
                if body.parentId is not None:
                    raise HTTPException(status_code=400, detail="A theme cannot have a parent.")
            else:
                _require_theme(conn, body.parentId)
            parent_id = body.parentId
            sets["parent_id"] = parent_id
        if ("name" in fields or "parentId" in fields) and _name_taken(
            conn, row["kind"], parent_id, name, exclude=series_id
        ):
            raise HTTPException(status_code=409, detail="name_taken")
        if "color" in fields:
            sets["color"] = _clean_color(body.color) if body.color else None
        if "archived" in fields and body.archived is not None:
            sets["archived"] = 1 if body.archived else 0
        if "coverImageId" in fields or "bestImageId" in fields:
            if row["kind"] != "series":
                raise HTTPException(status_code=400, detail="Only a series has a cover image.")
            cover_id = (
                body.coverImageId
                if "coverImageId" in fields
                else body.bestImageId
            )
            if cover_id is not None and not storage.get_image(conn, cover_id):
                raise HTTPException(status_code=404, detail="Image not found")
            sets["best_image_id"] = cover_id
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        sets["updated_at"] = now_timestamp()
        try:
            conn.execute(
                f"UPDATE series SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                (*sets.values(), series_id),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="name_taken")
        return _detail(conn, series_id)


@router.put("/{series_id}/marks/{image_id}")
def set_series_mark(series_id: int, image_id: int, body: SeriesMarkUpdate):
    """Set/replace one mark, or clear it with ``kind: null``.

    A mark is valid only for an image that a record in this series outputs.
    Rejecting the explicit cover clears that cover so the normal fallback
    takes over immediately.
    """
    with get_conn() as conn:
        require_leaf(conn, series_id)

        if body.kind is None:
            conn.execute(
                "DELETE FROM series_marks WHERE series_id = ? AND image_id = ?",
                (series_id, image_id),
            )
            created_at = None
        else:
            output = conn.execute(
                """SELECT 1 FROM generations
                   WHERE series_id = ? AND output_image_id = ? AND status != 'note'
                   LIMIT 1""",
                (series_id, image_id),
            ).fetchone()
            if not output:
                raise HTTPException(
                    status_code=400,
                    detail="Only an output image of this series can be marked.",
                )
            current = conn.execute(
                "SELECT kind, created_at FROM series_marks "
                "WHERE series_id = ? AND image_id = ?",
                (series_id, image_id),
            ).fetchone()
            created_at = (
                current["created_at"]
                if current and current["kind"] == body.kind
                else now_timestamp()
            )
            conn.execute(
                """INSERT INTO series_marks (series_id, image_id, kind, created_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(series_id, image_id) DO UPDATE SET
                       kind = excluded.kind, created_at = excluded.created_at""",
                (series_id, image_id, body.kind, created_at),
            )
            if body.kind == "reject":
                conn.execute(
                    "UPDATE series SET best_image_id = NULL "
                    "WHERE id = ? AND best_image_id = ?",
                    (series_id, image_id),
                )
    return {
        "series_id": series_id,
        "image_id": image_id,
        "kind": body.kind,
        "created_at": created_at,
    }


@router.post("/{series_id}/marks/clear")
def clear_series_marks(series_id: int, body: SeriesMarkClear):
    """Clear every pick. Reject marks and the explicit cover stay untouched."""
    if body.kind != "pick":
        raise HTTPException(status_code=400, detail="Only picks can be cleared.")
    with get_conn() as conn:
        require_leaf(conn, series_id)
        cur = conn.execute(
            "DELETE FROM series_marks WHERE series_id = ? AND kind = 'pick'",
            (series_id,),
        )
    return {"cleared": cur.rowcount}


@router.delete("/{series_id}")
def delete_series(series_id: int):
    """Delete a series (its records just lose the reference) or a theme (its
    series move to "No theme", renamed ``name (2)`` on a clash)."""
    with get_conn() as conn:
        row = _row(conn, series_id)
        moved = 0
        if row["kind"] == "theme":
            children = conn.execute(
                "SELECT id, name FROM series WHERE parent_id = ? ORDER BY id", (series_id,)
            ).fetchall()
            for child in children:
                new_name = _free_name(conn, "series", None, child["name"])
                conn.execute(
                    "UPDATE series SET parent_id = NULL, name = ?, updated_at = ? WHERE id = ?",
                    (new_name, now_timestamp(), child["id"]),
                )
                moved += 1
        cleared = conn.execute(
            "SELECT COUNT(*) c FROM generations WHERE series_id = ?", (series_id,)
        ).fetchone()["c"]
        # ON DELETE SET NULL covers this too; explicit so it never depends on
        # the foreign_keys pragma of whoever opens the database.
        conn.execute("UPDATE generations SET series_id = NULL WHERE series_id = ?", (series_id,))
        conn.execute("UPDATE drafts SET series_id = NULL WHERE series_id = ?", (series_id,))
        conn.execute("DELETE FROM series WHERE id = ?", (series_id,))
    return {"deleted": series_id, "movedSeries": moved, "clearedGenerations": cleared}


def _generation_ids_for_images(conn, image_ids: list[int]) -> list[int]:
    if not image_ids:
        return []
    ph = ",".join("?" * len(image_ids))
    return [
        r["id"]
        for r in conn.execute(
            f"SELECT id FROM generations WHERE output_image_id IN ({ph}) AND status != 'note'",
            image_ids,
        ).fetchall()
    ]


def _assign(conn, series_id: int | None, generation_ids: list[int], draft_ids: list[int]) -> dict:
    gen_ids = list(dict.fromkeys(generation_ids))
    d_ids = list(dict.fromkeys(draft_ids))
    moved = 0
    if gen_ids:
        ph = ",".join("?" * len(gen_ids))
        old_outputs = [
            (r["series_id"], r["output_image_id"])
            for r in conn.execute(
                f"SELECT series_id, output_image_id FROM generations WHERE id IN ({ph})",
                gen_ids,
            ).fetchall()
        ]
        if series_id is not None:
            moved = conn.execute(
                f"""SELECT COUNT(*) c FROM generations WHERE id IN ({ph})
                    AND series_id IS NOT NULL AND series_id != ?""",
                (*gen_ids, series_id),
            ).fetchone()["c"]
        conn.execute(
            f"UPDATE generations SET series_id = ? WHERE id IN ({ph}) AND status != 'note'",
            (series_id, *gen_ids),
        )
        series_marks.cleanup_detached_outputs(conn, old_outputs)
    if d_ids:
        ph = ",".join("?" * len(d_ids))
        conn.execute(f"UPDATE drafts SET series_id = ? WHERE id IN ({ph})", (series_id, *d_ids))
    if series_id is not None:
        conn.execute("UPDATE series SET updated_at = ? WHERE id = ?", (now_timestamp(), series_id))
        # The triggers placed each record by time; tidy up if that left a
        # gap too small to insert into later.
        series_order.renumber_if_tight(conn, series_id)
    return {"generations": len(gen_ids), "drafts": len(d_ids), "moved": moved}


@router.post("/unassign")
def unassign(body: SeriesAssign):
    """Take records out of whatever series they are in."""
    with get_conn() as conn:
        gen_ids = [*body.generationIds, *_generation_ids_for_images(conn, body.imageIds)]
        return _assign(conn, None, gen_ids, body.draftIds)


@router.post("/{series_id}/assign")
def assign(series_id: int, body: SeriesAssign):
    """Put records into this series, moving them out of any other one."""
    with get_conn() as conn:
        require_leaf(conn, series_id)
        gen_ids = [*body.generationIds, *_generation_ids_for_images(conn, body.imageIds)]
        return _assign(conn, series_id, gen_ids, body.draftIds)


@router.get("/{series_id}/generations")
def series_generations(
    series_id: int,
    status: str | None = None,
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """The series timeline, last first, using History's row shape.

    Rows follow the series order (``series_pos``), not time. Each carries
    ``seq`` (1-based #N in that order, over every attempt in the series
    regardless of the filter) and ``previous``: the attempt right before it in
    the order, so the client can diff prompts and parameters.
    """
    status_sql, status_params = "", []
    if status:
        if status not in _RESULT_FILTERS:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
        wanted = _RESULT_FILTERS[status]
        status_sql = f"WHERE status IN ({','.join('?' * len(wanted))})"
        status_params = list(wanted)
    with get_conn() as conn:
        require_leaf(conn, series_id)
        seqd = f"""
            SELECT g.*,
                   ROW_NUMBER() OVER (ORDER BY {series_order.ORDER_SQL}) AS seq,
                   LAG(id) OVER (ORDER BY {series_order.ORDER_SQL}) AS prev_id
            FROM generations g
            WHERE series_id = ? AND status != 'note'
        """
        rows = [
            dict(r)
            for r in conn.execute(
                f"WITH seqd AS ({seqd}) SELECT * FROM seqd {status_sql} "
                "ORDER BY seq DESC LIMIT ? OFFSET ?",
                (series_id, *status_params, limit, offset),
            ).fetchall()
        ]
        total = conn.execute(
            f"WITH seqd AS ({seqd}) SELECT COUNT(*) c FROM seqd {status_sql}",
            (series_id, *status_params),
        ).fetchone()["c"]
        counts = {"all": 0, "success": 0, "blocked": 0, "error": 0}
        for r in conn.execute(
            "SELECT status, COUNT(*) c FROM generations WHERE series_id = ? AND status != 'note' GROUP BY status",
            (series_id,),
        ).fetchall():
            counts["all"] += r["c"]
            for key, statuses in _RESULT_FILTERS.items():
                if r["status"] in statuses:
                    counts[key] += r["c"]
        prev_ids = [r["prev_id"] for r in rows if r["prev_id"]]
        previous: dict[int, dict] = {}
        if prev_ids:
            ph = ",".join("?" * len(prev_ids))
            prev_rows = conn.execute(
                f"WITH seqd AS ({seqd}) SELECT * FROM seqd WHERE id IN ({ph})",
                (series_id, *prev_ids),
            ).fetchall()
            input_rows = conn.execute(
                f"""SELECT generation_id, image_id FROM generation_inputs
                    WHERE generation_id IN ({ph}) ORDER BY generation_id, position""",
                prev_ids,
            ).fetchall()
            inputs: dict[int, list[int]] = {}
            for ir in input_rows:
                inputs.setdefault(ir["generation_id"], []).append(ir["image_id"])
            for p in prev_rows:
                previous[p["id"]] = {
                    "id": p["id"],
                    "seq": p["seq"],
                    "prompt": p["prompt"],
                    "provider": p["provider"],
                    "model": p["model"],
                    "aspect_ratio": p["aspect_ratio"],
                    "resolution": p["resolution"],
                    "status": p["status"],
                    "input_ids": inputs.get(p["id"], []),
                }
        out = _hydrate(conn, rows)
        marks = series_marks.for_series(conn, series_id)
        for g in out:
            pid = g.pop("prev_id", None)
            g["previous"] = previous.get(pid) if pid else None
            mark = marks.get(g["output_image_id"])
            g["mark"] = mark
            if g["outputImage"] is not None:
                g["outputImage"]["mark"] = mark
    return {"generations": out, "total": total, "counts": counts}


# --- custom order (series-v2 B2) ---------------------------------------------


def _order_result(conn, series_id: int, before: dict[int, int]) -> dict:
    after = series_order.seq_map(conn, series_id)
    return {
        "order_custom": series_order.order_custom(conn, series_id),
        "changed": series_order.changed_seqs(before, after),
    }


@router.post("/{series_id}/reorder")
def reorder(series_id: int, body: SeriesReorder):
    """Move records as one block (in their current relative order) right
    before or right after a target record. Returns ``order_custom`` and every
    record whose #N changed (``changed: [{id, seq, old_seq}]``)."""
    if (body.before is None) == (body.after is None):
        raise HTTPException(status_code=400, detail="Give exactly one of before / after.")
    target = body.before if body.before is not None else body.after
    wanted = set(body.generationIds)
    if not wanted:
        raise HTTPException(status_code=400, detail="Nothing to move")
    if target in wanted:
        raise HTTPException(status_code=400, detail="The target cannot be one of the moved records.")
    with get_conn() as conn:
        require_leaf(conn, series_id)
        current = series_order.ordered_ids(conn, series_id)
        members = set(current)
        if not wanted <= members:
            raise HTTPException(status_code=400, detail="Every moved record must be in this series.")
        if target not in members:
            raise HTTPException(status_code=400, detail="The target must be in this series.")
        before = series_order.seq_map(conn, series_id)
        block = [gid for gid in current if gid in wanted]
        series_order.move_block(conn, series_id, block, body.before, body.after)
        return _order_result(conn, series_id, before)


@router.post("/{series_id}/reorder/reset")
def reorder_reset(series_id: int):
    """Back to time order. ``previous_order`` is the full order before, for
    the client's Undo (``reorder/restore``)."""
    with get_conn() as conn:
        require_leaf(conn, series_id)
        before = series_order.seq_map(conn, series_id)
        previous = series_order.ordered_ids(conn, series_id)
        series_order.write_order(conn, series_order.time_ids(conn, series_id, notes=True))
        out = _order_result(conn, series_id, before)
    out["previous_order"] = previous
    return out


@router.post("/{series_id}/reorder/restore")
def reorder_restore(series_id: int, body: SeriesRestore):
    """Write a complete order back. Ids no longer in the series are ignored;
    records of the series missing from the list (added in the meantime) are
    placed by the time rule, as if they had just been filed."""
    with get_conn() as conn:
        require_leaf(conn, series_id)
        before = series_order.seq_map(conn, series_id)
        members = set(series_order.ordered_ids(conn, series_id))
        listed = [gid for gid in dict.fromkeys(body.generationIds) if gid in members]
        listed_set = set(listed)
        rest = [
            gid for gid in series_order.time_ids(conn, series_id, notes=True)
            if gid not in listed_set
        ]
        if rest:
            ph = ",".join("?" * len(rest))
            conn.execute(f"UPDATE generations SET series_pos = NULL WHERE id IN ({ph})", rest)
        series_order.write_order(conn, listed)
        for gid in rest:
            series_order.place_by_time(conn, gid)
        series_order.renumber_if_tight(conn, series_id)
        return _order_result(conn, series_id, before)


@router.get("/{series_id}/order")
def series_order_map(series_id: int):
    """The whole series order, small (series-v2 B4): every record's #N, vK,
    status and configuration key (an index into ``keys``), oldest first.
    The reorder UI needs version boundaries beyond the loaded pages: up /
    down jump over whole neighbouring versions, the position picker lists
    every version, and a drop on a filter-hidden version moves past all of it.
    """
    with get_conn() as conn:
        require_leaf(conn, series_id)
        rows = [
            dict(r)
            for r in conn.execute(
                f"""SELECT id, prompt, model, aspect_ratio, resolution, status, created_at,
                           output_image_id,
                           ROW_NUMBER() OVER (ORDER BY {series_order.ORDER_SQL}) AS seq
                    FROM generations WHERE series_id = ? AND status != 'note'
                    ORDER BY {series_order.ORDER_SQL}""",
                (series_id,),
            ).fetchall()
        ]
        inputs: dict[int, list[int]] = {}
        for ir in conn.execute(
            """SELECT gi.generation_id, gi.image_id FROM generation_inputs gi
               JOIN generations g ON g.id = gi.generation_id
               WHERE g.series_id = ? ORDER BY gi.generation_id, gi.position""",
            (series_id,),
        ).fetchall():
            inputs.setdefault(ir["generation_id"], []).append(ir["image_id"])
        keys: list[str] = []
        key_index: dict[str, int] = {}
        items = []
        for v in series_order.group_versions(rows, inputs):
            k = key_index.setdefault(v["key"], len(keys))
            if k == len(keys):
                keys.append(v["key"])
            for r in v["rows"]:
                items.append({
                    "id": r["id"],
                    "seq": r["seq"],
                    "version": v["version"],
                    "k": k,
                    "status": r["status"],
                    "created_at": r["created_at"],
                    "output_image_id": r["output_image_id"],
                })
        return {
            "items": items,
            "keys": keys,
            "order_custom": series_order.order_custom(conn, series_id),
        }


# --- versions (series-v2 B2) --------------------------------------------------

VERSION_PAGE = 15
VERSION_ATTEMPTS_MAX = 200


def _attempt(row: dict, outputs: dict[int, dict], marks: dict[int, str]) -> dict:
    out = outputs.get(row["output_image_id"]) if row["output_image_id"] else None
    mark = marks.get(row["output_image_id"]) if row["output_image_id"] else None
    output = storage.public_image(out) if out else None
    if output is not None:
        output["mark"] = mark
    return {
        "id": row["id"],
        "seq": row["seq"],
        "status": row["status"],
        "provider": row["provider"],
        "source": row["source"],
        "created_at": row["created_at"],
        "error_message": row["error_message"],
        "raw_finish": row["raw_finish"],
        "duration_ms": row["duration_ms"],
        "attempts": row["attempts"],
        "marker_color": row["marker_color"],
        "output_image_id": row["output_image_id"],
        "outputImage": output,
        "mark": mark,
    }


def _version_counts(rows: list[dict]) -> dict:
    counts = {"all": len(rows), "success": 0, "blocked": 0, "error": 0, "aborted": 0}
    for r in rows:
        if r["status"] in counts:
            counts[r["status"]] += 1
    return counts


@router.get("/{series_id}/versions")
def series_versions(
    series_id: int,
    status: str | None = None,
    cursor: int | None = Query(None, ge=1),
    limit: int = Query(VERSION_PAGE, ge=1, le=100),
):
    """The series as versions, newest first, paged by version.

    Consecutive attempts with the same ``version_key`` are one version, over
    the full series order. ``status`` also accepts ``pick`` / ``reject`` for
    mark filters, and only filters each version's
    ``attempts``: a version with none left is still returned with
    ``hidden: true`` and its counts, and ``base_version`` always points at the
    previous version of the full order. ``cursor`` is a version number: the
    page holds the versions below it. A version lists at most 200 attempts
    (the last ones in order); ``attempts_total`` is the unclipped count.
    """
    wanted = None
    mark_filter = None
    if status:
        if status in series_marks.MARK_KINDS:
            mark_filter = status
        elif status not in _RESULT_FILTERS:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
        else:
            wanted = set(_RESULT_FILTERS[status])
    with get_conn() as conn:
        require_leaf(conn, series_id)
        rows = [
            dict(r)
            for r in conn.execute(
                f"""SELECT id, prompt, model, aspect_ratio, resolution, status, provider,
                           source, created_at, error_message, raw_finish, duration_ms,
                           attempts, marker_color, output_image_id,
                           ROW_NUMBER() OVER (ORDER BY {series_order.ORDER_SQL}) AS seq
                    FROM generations WHERE series_id = ? AND status != 'note'
                    ORDER BY {series_order.ORDER_SQL}""",
                (series_id,),
            ).fetchall()
        ]
        inputs: dict[int, list[int]] = {}
        for ir in conn.execute(
            """SELECT gi.generation_id, gi.image_id FROM generation_inputs gi
               JOIN generations g ON g.id = gi.generation_id
               WHERE g.series_id = ? ORDER BY gi.generation_id, gi.position""",
            (series_id,),
        ).fetchall():
            inputs.setdefault(ir["generation_id"], []).append(ir["image_id"])
        versions = series_order.group_versions(rows, inputs)
        marks = series_marks.for_series(conn, series_id)
        total = len(versions)
        top = min(cursor - 1, total) if cursor is not None else total
        page = versions[max(0, top - limit):top][::-1]

        shown: dict[int, list[dict]] = {}

        def matches(row: dict) -> bool:
            if mark_filter is not None:
                image_id = row["output_image_id"]
                return bool(image_id) and marks.get(image_id) == mark_filter
            return wanted is None or row["status"] in wanted

        for v in page:
            match = [r for r in v["rows"] if matches(r)]
            shown[v["version"]] = match
        out_ids = [
            r["output_image_id"]
            for match in shown.values()
            for r in match[-VERSION_ATTEMPTS_MAX:]
            if r["output_image_id"]
        ]
        # The version's input images (one set per version; reuse needs rows).
        in_ids = list({i for v in page for i in v["params"]["input_ids"]})
        in_rows: dict[int, dict] = {}
        if in_ids:
            ph = ",".join("?" * len(in_ids))
            in_rows = {
                r["id"]: dict(r)
                for r in conn.execute(f"SELECT * FROM images WHERE id IN ({ph})", in_ids).fetchall()
            }
        by_number = {v["version"]: v for v in versions}
        outputs: dict[int, dict] = {}
        if out_ids:
            ph = ",".join("?" * len(out_ids))
            outputs = {
                r["id"]: dict(r)
                for r in conn.execute(f"SELECT * FROM images WHERE id IN ({ph})", out_ids).fetchall()
            }
        result = []
        for v in page:
            match = shown[v["version"]]
            item = {
                "version": v["version"],
                "key": v["key"],
                "first_seq": v["rows"][0]["seq"],
                "last_seq": v["rows"][-1]["seq"],
                "prompt": v["prompt"],
                "params": v["params"],
                "changed_params": v["changed_params"],
                "prompt_changed": v["prompt_changed"],
                "base_version": v["base_version"],
                # The baseline itself, so a diff never waits for the next page.
                "base_prompt": by_number[v["base_version"]]["prompt"] if v["base_version"] else None,
                "base_params": by_number[v["base_version"]]["params"] if v["base_version"] else None,
                # The filter hides every attempt of the baseline ("vs v4 (hidden)").
                "base_hidden": bool(v["base_version"]) and status is not None and not any(
                    matches(r) for r in by_number[v["base_version"]]["rows"]
                ),
                "inputs": [
                    storage.public_image(in_rows[i]) for i in v["params"]["input_ids"] if i in in_rows
                ],
                "attempts": [
                    _attempt(r, outputs, marks) for r in match[-VERSION_ATTEMPTS_MAX:]
                ],
                "attempts_total": len(match),
                "counts": _version_counts(v["rows"]),
                "hidden": not match,
            }
            result.append(item)
        next_cursor = page[-1]["version"] if page and page[-1]["version"] > 1 else None
        return {
            "versions": result,
            "total": total,
            "next_cursor": next_cursor,
            "order_custom": series_order.order_custom(conn, series_id),
        }
