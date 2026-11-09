"""Shared per-day timeline queries for virtual collections."""
from __future__ import annotations

from collections.abc import Sequence

from .db import get_conn

MAX_IDS_LIMIT = 5000


def query_timeline(
    *,
    source: str,
    where: str,
    params: Sequence[object],
    order: str,
    date_expr: str,
    tz: int,
) -> dict:
    """Return days/runs/total for one list order.

    ``source`` is the FROM expression, ``where`` includes its own WHERE, and
    ``date_expr`` takes one ``?`` (minutes east of UTC). ``first_index`` is a
    ROW_NUMBER over the exact same ``order`` as the list endpoint; ``runs`` is
    the day at every position where it changes. Neither assumes dates follow
    the id order.
    """
    ordered = f"""
        WITH ordered AS (
            SELECT {date_expr} AS day,
                   ROW_NUMBER() OVER (ORDER BY {order}) - 1 AS idx
            FROM {source} {where}
        )
    """
    days_sql = ordered + """
        SELECT day, COUNT(*) AS count, MIN(idx) AS first_index
        FROM ordered GROUP BY day
        ORDER BY (day IS NULL), day DESC
    """
    runs_sql = ordered + """
        , marked AS (
            SELECT idx, day, LAG(day) OVER (ORDER BY idx) AS prev FROM ordered
        )
        SELECT idx, day FROM marked
        WHERE idx = 0 OR day IS NOT prev
        ORDER BY idx
    """
    args = (f"{tz:+d} minutes", *params)
    with get_conn() as conn:
        rows = conn.execute(days_sql, args).fetchall()
        runs = conn.execute(runs_sql, args).fetchall()
    days = [
        {
            "day": row["day"] or "unknown",
            "count": row["count"],
            "first_index": row["first_index"],
        }
        for row in rows
    ]
    return {
        "days": days,
        "runs": [[row["idx"], row["day"] or "unknown"] for row in runs],
        "total": sum(day["count"] for day in days),
    }
