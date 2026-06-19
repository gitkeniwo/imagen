"""Usage statistics: read-only aggregates over generations / images / tags.

All numbers are facts from the local SQLite DB. Cost is NOT computed here — the
app cannot see real Vertex billing, so the frontend multiplies the success
counts (cost_basis) by user-configurable unit prices and labels it an estimate.
"""
from datetime import date, timedelta

from fastapi import APIRouter

from ..db import get_conn

router = APIRouter(prefix="/api/stats", tags=["stats"])


def _series_from(parsed, ordered_keys, keyfn):
    """Aggregate (date,status) rows into ordered {label,total,success} buckets."""
    agg = {k: [0, 0] for k, _ in ordered_keys}
    for d, st in parsed:
        k = keyfn(d)
        if k in agg:
            agg[k][0] += 1
            if st == "success":
                agg[k][1] += 1
    return [
        {"label": lbl, "total": agg[k][0], "success": agg[k][1]}
        for k, lbl in ordered_keys
    ]


def _build_series(rows):
    """Dense time series at day / week / month / year granularity."""
    parsed = []
    for ts, st in rows:
        if not ts:
            continue
        try:
            parsed.append((date.fromisoformat(ts[:10]), st))
        except ValueError:
            continue
    today = date.today()

    days = [today - timedelta(days=i) for i in range(29, -1, -1)]
    day = _series_from(
        parsed,
        [(d.isoformat(), d.strftime("%m-%d")) for d in days],
        lambda d: d.isoformat(),
    )

    this_monday = today - timedelta(days=today.weekday())
    weeks = [this_monday - timedelta(weeks=i) for i in range(25, -1, -1)]
    week = _series_from(
        parsed,
        [(w.isoformat(), w.strftime("%m-%d")) for w in weeks],
        lambda d: (d - timedelta(days=d.weekday())).isoformat(),
    )

    months = []
    y, m = today.year, today.month
    for _ in range(12):
        months.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    months.reverse()
    month = _series_from(
        parsed,
        [(f"{yy}-{mm:02d}", f"{yy}-{mm:02d}") for yy, mm in months],
        lambda d: f"{d.year}-{d.month:02d}",
    )

    first_year = max(min((d.year for d, _ in parsed), default=today.year), today.year - 7)
    year = _series_from(
        parsed,
        [(str(yy), str(yy)) for yy in range(first_year, today.year + 1)],
        lambda d: str(d.year),
    )

    return {"day": day, "week": week, "month": month, "year": year}


@router.get("")
def get_stats():
    with get_conn() as conn:
        g_total = conn.execute("SELECT COUNT(*) c FROM generations").fetchone()["c"]
        by_status = {
            r["status"]: r["c"]
            for r in conn.execute(
                "SELECT status, COUNT(*) c FROM generations GROUP BY status"
            )
        }
        by_model = {
            r["model"]: r["c"]
            for r in conn.execute(
                "SELECT model, COUNT(*) c FROM generations GROUP BY model"
            )
        }
        today = conn.execute(
            "SELECT COUNT(*) c FROM generations "
            "WHERE substr(created_at,1,10) = date('now')"
        ).fetchone()["c"]
        last7 = conn.execute(
            "SELECT COUNT(*) c FROM generations "
            "WHERE substr(created_at,1,10) >= date('now','-6 days')"
        ).fetchone()["c"]
        span = conn.execute(
            "SELECT MIN(created_at) lo, MAX(created_at) hi FROM generations"
        ).fetchone()

        # Time series at day/week/month/year granularity (built in Python from
        # the full (created_at,status) history — single-user scale is small).
        series = _build_series(
            [
                (r["created_at"], r["status"])
                for r in conn.execute("SELECT created_at, status FROM generations")
            ]
        )

        cost_basis = [
            {"model": r["model"], "resolution": r["resolution"], "count": r["c"]}
            for r in conn.execute(
                "SELECT model, resolution, COUNT(*) c FROM generations "
                "WHERE status='success' GROUP BY model, resolution"
            )
        ]

        img_total = conn.execute(
            "SELECT COUNT(*) c FROM images WHERE deleted_at IS NULL"
        ).fetchone()["c"]
        by_source = {
            r["source"]: r["c"]
            for r in conn.execute(
                "SELECT source, COUNT(*) c FROM images "
                "WHERE deleted_at IS NULL GROUP BY source"
            )
        }
        img_bytes = conn.execute(
            "SELECT COALESCE(SUM(byte_size),0) b FROM images WHERE deleted_at IS NULL"
        ).fetchone()["b"]
        tags = conn.execute("SELECT COUNT(*) c FROM tags").fetchone()["c"]

    return {
        "generations": {
            "total": g_total,
            "by_status": by_status,
            "by_model": by_model,
            "today": today,
            "last7": last7,
            "first_at": span["lo"],
            "last_at": span["hi"],
        },
        "images": {"total": img_total, "by_source": by_source, "bytes": img_bytes},
        "tags": tags,
        "series": series,
        "cost_basis": cost_basis,
    }
