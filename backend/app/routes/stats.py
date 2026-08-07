"""Usage statistics: read-only aggregates over generations / images / tags.

Everything is scoped by a time window (day / week / month / year / all) so the
whole dashboard — counts, status & model breakdowns, storage AND the cost
estimate — switches together. All windows are precomputed in one response
(single-user scale is tiny) so the UI can toggle instantly without refetching.

Cost is NOT computed here — the app cannot see real Vertex billing, so the
frontend multiplies the per-period success counts (cost_basis) by
user-configurable unit prices and labels it an estimate.
"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter

from ..db import get_conn

router = APIRouter(prefix="/api/stats", tags=["stats"])

PERIODS = ["day", "week", "month", "year", "all"]


def _parse_dt(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _in_window(d: date, period: str, today: date) -> bool:
    if period == "all":
        return True
    if period == "day":
        return d == today
    if period == "week":
        return d >= today - timedelta(days=6)
    if period == "month":
        return d >= today - timedelta(days=29)
    if period == "year":
        return d >= today - timedelta(days=364)
    return False


def _series_from(rows, ordered_keys, keyfn):
    """Aggregate (dt,status) rows into ordered {label,total,success} buckets."""
    agg = {k: [0, 0] for k, _ in ordered_keys}
    for dt, st in rows:
        k = keyfn(dt)
        if k in agg:
            agg[k][0] += 1
            if st == "success":
                agg[k][1] += 1
    return [
        {"label": lbl, "total": agg[k][0], "success": agg[k][1]}
        for k, lbl in ordered_keys
    ]


def _chart(rows, period: str, today: date):
    """Trend bars for the window, sub-bucketed by a natural unit."""
    if period == "day":  # by hour
        keys = [(f"{h:02d}", f"{h:02d}") for h in range(24)]
        return _series_from(rows, keys, lambda dt: f"{dt.hour:02d}")
    if period in ("week", "month"):  # by day
        n = 7 if period == "week" else 30
        days = [today - timedelta(days=i) for i in range(n - 1, -1, -1)]
        return _series_from(
            rows,
            [(d.isoformat(), d.strftime("%m-%d")) for d in days],
            lambda dt: dt.date().isoformat(),
        )
    if period == "year":  # by month, last 12
        months, y, m = [], today.year, today.month
        for _ in range(12):
            months.append((y, m))
            m -= 1
            if m == 0:
                m, y = 12, y - 1
        months.reverse()
        return _series_from(
            rows,
            [(f"{yy}-{mm:02d}", f"{yy}-{mm:02d}") for yy, mm in months],
            lambda dt: f"{dt.year}-{dt.month:02d}",
        )
    # all → by year
    yrs = [dt.year for dt, _ in rows]
    first = min(yrs, default=today.year)
    return _series_from(
        rows,
        [(str(yy), str(yy)) for yy in range(first, today.year + 1)],
        lambda dt: str(dt.year),
    )


@router.get("")
def get_stats():
    with get_conn() as conn:
        gens = [
            (_parse_dt(r["created_at"]), r["status"], r["model"], r["resolution"])
            for r in conn.execute(
                "SELECT created_at, status, model, resolution FROM generations "
                "WHERE status NOT IN ('note', 'running')"
            )
        ]
        gens = [g for g in gens if g[0] is not None]
        imgs = [
            (_parse_dt(r["created_at"]), r["byte_size"] or 0, r["source"])
            for r in conn.execute(
                "SELECT created_at, byte_size, source FROM images "
                "WHERE deleted_at IS NULL"
            )
        ]
        imgs = [i for i in imgs if i[0] is not None]
        tags = conn.execute("SELECT COUNT(*) c FROM tags").fetchone()["c"]

    today = date.today()
    periods = {}
    for p in PERIODS:
        gsub = [g for g in gens if _in_window(g[0].date(), p, today)]
        isub = [i for i in imgs if _in_window(i[0].date(), p, today)]

        by_status, by_model, cost = {}, {}, {}
        for _, st, model, res in gsub:
            by_status[st] = by_status.get(st, 0) + 1
            by_model[model] = by_model.get(model, 0) + 1
            if st == "success":
                cost[(model, res)] = cost.get((model, res), 0) + 1

        by_source, bytes_sum = {}, 0
        for _, bs, src in isub:
            by_source[src] = by_source.get(src, 0) + 1
            bytes_sum += bs

        periods[p] = {
            "total": len(gsub),
            "by_status": by_status,
            "by_model": by_model,
            "cost_basis": [
                {"model": m, "resolution": r, "count": c}
                for (m, r), c in cost.items()
            ],
            "images": {"total": len(isub), "by_source": by_source, "bytes": bytes_sum},
            "chart": _chart([(g[0], g[1]) for g in gsub], p, today),
        }

    dts = [g[0] for g in gens]
    return {
        "periods": periods,
        "tags": tags,
        "first_at": min(dts).isoformat() if dts else None,
        "last_at": max(dts).isoformat() if dts else None,
    }
