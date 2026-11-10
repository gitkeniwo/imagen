"""Custom order and versions inside a series (series-v2 B2).

Order: ``generations.series_pos`` (see ``db.py`` for the placement triggers).
``#N`` is a record's 1-based rank by ``(series_pos, id)`` among the series'
non-note records; it is always computed, never stored.

Versions: consecutive attempts with the same configuration (``version_key``)
form one version. Only neighbors merge, so A A B A is three versions.
"""
from __future__ import annotations

import json

from .db import GENERATION_SORT_AT, SERIES_POS_EPSILON, SERIES_POS_STEP, place_by_time_sql

ORDER_SQL = "series_pos ASC, id ASC"
TIME_SQL = f"{GENERATION_SORT_AT} ASC, id ASC"

# JavaScript's String.prototype.trim() set (WhiteSpace + LineTerminator).
# Python's str.strip() differs (it keeps U+FEFF, strips U+001C–U+001F), and the
# key must match the frontend's `samePrompt` exactly.
_JS_TRIM = (
    "\t\n\v\f\r          "
    "        　﻿"
)

# Parameters of a version besides the prompt; also the `changed_params` keys.
PARAM_KEYS = ("model", "aspect_ratio", "resolution", "inputs")


def normalize_prompt(prompt: str | None) -> str:
    """Same rule as ``samePrompt`` in frontend/src/promptDiff.ts."""
    return (prompt or "").strip(_JS_TRIM)


def version_key(
    prompt: str | None,
    model: str | None,
    resolution: str | None,
    aspect_ratio: str | None,
    input_ids: list[int],
) -> str:
    """The configuration that makes two attempts "the same version".

    Provider is deliberately not part of it (design decision 3). Keep in
    sync with ``versionKey`` in frontend/src/promptDiff.ts; both are checked
    against frontend/scripts/fixtures/version-key.json.
    """
    return json.dumps(
        [normalize_prompt(prompt), model or "", resolution or "", aspect_ratio or "",
         list(input_ids)],
        ensure_ascii=False,
        separators=(",", ":"),
    )


# --- order ---------------------------------------------------------------


def _ids(conn, series_id: int, order: str, notes: bool) -> list[int]:
    hide = "" if notes else " AND status != 'note'"
    return [
        r["id"]
        for r in conn.execute(
            f"SELECT id FROM generations WHERE series_id = ?{hide} ORDER BY {order}",
            (series_id,),
        ).fetchall()
    ]


def ordered_ids(conn, series_id: int, notes: bool = False) -> list[int]:
    """Records in series order; legacy notes only when asked for."""
    return _ids(conn, series_id, ORDER_SQL, notes)


def time_ids(conn, series_id: int, notes: bool = False) -> list[int]:
    """Records in time order (History's order, oldest first)."""
    return _ids(conn, series_id, TIME_SQL, notes)


def order_custom(conn, series_id: int) -> bool:
    """True when the series order differs from time order."""
    return ordered_ids(conn, series_id) != time_ids(conn, series_id)


def renumber_if_tight(conn, series_id: int) -> bool:
    """Renumber the series ``n * STEP`` (same order) when two neighbors are
    closer than ``SERIES_POS_EPSILON``. Returns whether it did."""
    rows = conn.execute(
        f"SELECT id, series_pos FROM generations WHERE series_id = ? ORDER BY {ORDER_SQL}",
        (series_id,),
    ).fetchall()
    pos = [r["series_pos"] for r in rows]
    tight = any(p is None for p in pos) or any(
        b - a < SERIES_POS_EPSILON for a, b in zip(pos, pos[1:])
    )
    if not tight:
        return False
    write_order(conn, [r["id"] for r in rows])
    return True


_PLACE_SQL = place_by_time_sql("?")


def place_by_time(conn, generation_id: int) -> None:
    """Place one record of its series by the time rule (§3 rule 1); it must
    have no position yet. The same SQL the triggers run."""
    conn.execute(_PLACE_SQL, (generation_id,))


def write_order(conn, ids: list[int]) -> None:
    """Rewrite positions to ``n * STEP`` following ``ids``."""
    conn.executemany(
        "UPDATE generations SET series_pos = ? WHERE id = ?",
        [((i + 1) * SERIES_POS_STEP, gid) for i, gid in enumerate(ids)],
    )


def move_block(conn, series_id: int, block: list[int], before: int | None, after: int | None) -> None:
    """Move ``block`` (already in current order) next to the target.

    Only the moved rows get new positions, spread evenly in the gap between
    their new neighbors; the series is renumbered when that gap is too small.
    """
    rows = conn.execute(
        f"SELECT id, series_pos FROM generations WHERE series_id = ? ORDER BY {ORDER_SQL}",
        (series_id,),
    ).fetchall()
    moving = set(block)
    rest = [(r["id"], r["series_pos"]) for r in rows if r["id"] not in moving]
    target = before if before is not None else after
    at = next(i for i, (gid, _) in enumerate(rest) if gid == target)
    if after is not None:
        at += 1
    lo = rest[at - 1][1] if at > 0 else None
    hi = rest[at][1] if at < len(rest) else None
    k = len(block)
    if lo is None and hi is None:
        new = [(i + 1) * SERIES_POS_STEP for i in range(k)]
    elif lo is None:
        new = [hi - (k - i) * SERIES_POS_STEP for i in range(k)]
    elif hi is None:
        new = [lo + (i + 1) * SERIES_POS_STEP for i in range(k)]
    else:
        new = [lo + (hi - lo) * (i + 1) / (k + 1) for i in range(k)]
    conn.executemany(
        "UPDATE generations SET series_pos = ? WHERE id = ?", list(zip(new, block))
    )
    renumber_if_tight(conn, series_id)


def seq_map(conn, series_id: int) -> dict[int, int]:
    return {gid: i + 1 for i, gid in enumerate(ordered_ids(conn, series_id))}


def changed_seqs(before: dict[int, int], after: dict[int, int]) -> list[dict]:
    """Records whose #N changed, in new order."""
    return [
        {"id": gid, "seq": seq, "old_seq": before.get(gid)}
        for gid, seq in sorted(after.items(), key=lambda kv: kv[1])
        if before.get(gid) != seq
    ]


# --- versions --------------------------------------------------------------


def _params(row: dict, inputs: list[int]) -> dict:
    return {
        "model": row["model"],
        "aspect_ratio": row["aspect_ratio"],
        "resolution": row["resolution"],
        "input_ids": inputs,
    }


def changed_params(prev: dict | None, cur: dict) -> list[str]:
    """``PARAM_KEYS`` that differ from the previous version (none for v1)."""
    if prev is None:
        return []
    out = []
    for k in PARAM_KEYS:
        if k == "inputs":
            if list(prev["input_ids"]) != list(cur["input_ids"]):
                out.append(k)
        elif (prev[k] or "") != (cur[k] or ""):
            out.append(k)
    return out


def group_versions(rows: list[dict], inputs: dict[int, list[int]]) -> list[dict]:
    """Group ``rows`` (series order, each with ``seq``) into versions.

    Returns every version with all its attempts; filtering and paging are the
    caller's job, so ``base_version`` always refers to the full order.
    """
    versions: list[dict] = []
    for row in rows:
        ins = inputs.get(row["id"], [])
        key = version_key(row["prompt"], row["model"], row["resolution"], row["aspect_ratio"], ins)
        if versions and versions[-1]["key"] == key:
            versions[-1]["rows"].append(row)
            continue
        prev = versions[-1] if versions else None
        params = _params(row, ins)
        versions.append({
            "version": len(versions) + 1,
            "key": key,
            "prompt": row["prompt"] or "",
            "params": params,
            "changed_params": changed_params(prev["params"] if prev else None, params),
            "prompt_changed": bool(prev) and normalize_prompt(prev["prompt"]) != normalize_prompt(row["prompt"]),
            "base_version": prev["version"] if prev else None,
            "rows": [row],
        })
    return versions
