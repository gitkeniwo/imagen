#!/usr/bin/env python3
"""Library timeline / ids endpoint checks against a throwaway data directory.

Rows are inserted straight into a fresh SQLite database (no image files are
needed for these endpoints) and the API is exercised in-process with FastAPI's
TestClient. No provider is called.

    uv run --project backend python desktop/scripts/check_timeline.py

Covers: first_index vs. offset paging, shared filters (source/starred/tag/q),
the tz day boundary, out-of-order created_at, NULL/garbage dates, and the
/ids range + limit.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
data_dir = Path(tempfile.mkdtemp(prefix="imagen-timeline-"))
os.environ["IMAGEN_DATA_DIR"] = str(data_dir)
sys.path.insert(0, str(REPO / "backend"))

from app import db  # noqa: E402

failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


db.init_storage()
conn = sqlite3.connect(db.DB_PATH)

# id -> (created_at, source, starred, filename, deleted)
# Listed newest id first below only for reading; ids are assigned ascending.
ROWS = [
    # old, oldest ids
    ("2025-12-31T23:30:00.000000+00:00", "upload", 0, "a-old.png", False),     # 1
    ("2026-01-01T00:10:00.000000+00:00", "generated", 1, "b.png", False),      # 2
    ("2026-03-14T08:00:00.000000+00:00", "upload", 0, "cat.png", False),       # 3
    ("2026-03-14T09:00:00.000000+00:00", "generated", 0, "dog.png", False),    # 4
    # out of order: a high id carrying an OLD date (imported row)
    ("2026-03-14T10:00:00.000000+00:00", "upload", 1, "import-cat.png", False),  # 5
    ("2026-01-01T12:00:00.000000+00:00", "upload", 0, "late-import.png", False),  # 6
    ("2026-03-15T23:59:59+00:00", "generated", 0, "edge.png", False),          # 7
    ("2026-03-16T00:00:00Z", "upload", 0, "z-suffix.png", False),              # 8
    (None, "upload", 0, "nodate.png", False),                                  # 9
    ("not a date", "upload", 0, "garbage.png", False),                         # 10
    ("2026-03-14T11:00:00.000000+00:00", "upload", 0, "binned.png", True),     # 11
    ("2026-11-01T10:00:00.000000+00:00", "generated", 0, "new.png", False),    # 12
]
for i, (at, source, starred, name, deleted) in enumerate(ROWS, start=1):
    conn.execute(
        "INSERT INTO images (sha256, filename, mime, width, height, byte_size, source, "
        "file_path, thumb_path, starred, created_at, deleted_at) "
        "VALUES (?, ?, 'image/png', 2, 2, 10, ?, ?, ?, ?, ?, ?)",
        (f"{i:064d}", name, source, f"images/{i}.png", f"thumbs/{i}.webp", starred, at,
         "2026-11-02T00:00:00+00:00" if deleted else None),
    )
conn.execute("INSERT INTO tags (name, created_at) VALUES ('cats', '2026-01-01T00:00:00+00:00')")
conn.execute("INSERT INTO image_tags (image_id, tag_id) VALUES (3, 1), (5, 1)")
# an "app" (vertex) and an "imported" (manual) generation output
conn.execute(
    "INSERT INTO generations (prompt, model, status, output_image_id, created_at, source, provider) "
    "VALUES ('p', 'm', 'success', 2, '2026-01-01T00:00:00+00:00', 'vertex', 'vertex')"
)
conn.execute(
    "INSERT INTO generations (prompt, model, status, output_image_id, created_at, source, provider) "
    "VALUES ('p', 'm', 'success', 4, '2026-01-01T00:00:00+00:00', 'manual', 'vertex')"
)
conn.commit()
conn.close()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app, base_url="http://127.0.0.1")


def get(path: str, **params):
    res = c.get(path, params={k: v for k, v in params.items() if v is not None})
    return res


def timeline(**params) -> dict:
    res = get("/api/images/timeline", **params)
    check(res.status_code == 200, f"timeline {params} -> {res.status_code}")
    return res.json()


def listing(**params) -> dict:
    return get("/api/images", limit=500, **params).json()


def by_day(t: dict) -> dict:
    return {d["day"]: d for d in t["days"]}


# --- unfiltered: totals, order, first_index vs real offsets -----------------
t = timeline()
lst = listing()
check(t["total"] == lst["total"] == 11, f"total matches list ({t['total']} vs {lst['total']}); bin excluded")
check(sum(d["count"] for d in t["days"]) == t["total"], "day counts add up to total")
days = [d["day"] for d in t["days"]]
check(days == sorted((d for d in days if d != "unknown"), reverse=True) + ["unknown"],
      "days newest first, 'unknown' last")
ids_in_order = [img["id"] for img in lst["images"]]
check(ids_in_order == sorted(ids_in_order, reverse=True), "list order is id DESC")

dates = {img["id"]: img["created_at"] for img in lst["images"]}


def day_of(created: str | None) -> str:
    return created[:10] if created and created[:4].isdigit() and created[4] == "-" else "unknown"


for d in t["days"]:
    page = get("/api/images", limit=1, offset=d["first_index"]).json()["images"]
    first = page[0]
    expect_day = day_of(dates[first["id"]]) if d["day"] != "unknown" else "unknown"
    check(expect_day == d["day"], f"first_index {d['first_index']} lands on day {d['day']}")
    # nothing of that day appears before first_index
    earlier = [i for i in ids_in_order[: d["first_index"]] if day_of(dates[i]) == d["day"]]
    check(not earlier, f"no {d['day']} image before its first_index")

# runs: the day at every list position, read back from the runs, must equal
# the day of the image actually at that position (strays included).
runs = t["runs"]
check(runs and runs[0][0] == 0, "runs start at index 0")
check([r[0] for r in runs] == sorted({r[0] for r in runs}), "run starts strictly increasing")
check(all(a[1] != b[1] for a, b in zip(runs, runs[1:])), "adjacent runs differ in day")
starts = [r[0] for r in runs]
for pos, image_id in enumerate(ids_in_order):
    k = max(i for i, s in enumerate(starts) if s <= pos)
    check(runs[k][1] == day_of(dates[image_id]), f"runs: position {pos} is {day_of(dates[image_id])}")
# id 6 (2026-01-01) sits between 2026-03-14 rows: three runs, not one.
check([r[1] for r in runs[:6]] ==
      ["2026-11-01", "unknown", "2026-03-16", "2026-03-15", "2026-01-01", "2026-03-14"],
      f"stray row splits the run sequence ({[r[1] for r in runs[:6]]})")

dd = by_day(t)
# 2026-03-14 has ids 3, 4, 5 (the bin row 11 is excluded); id 6 is 2026-01-01.
check(dd["2026-03-14"]["count"] == 3, "03-14 count excludes binned row")
check(dd["2026-01-01"]["count"] == 2, "out-of-order id 6 joins 2026-01-01 (ids 2 and 6)")
# list is ids 12..1 minus 11 -> index of id 6 is 5; id 2 is 9. min = 5
check(dd["2026-01-01"]["first_index"] == ids_in_order.index(6),
      "out-of-order day: first_index is the earliest LIST position (id 6), not the lowest id")
check(dd["unknown"]["count"] == 2, "NULL and garbage created_at both land in 'unknown'")
check(dd["2026-03-16"]["count"] == 1, "'Z'-suffixed timestamp parses")
check(dd["2026-03-15"]["count"] == 1, "no-fraction +00:00 timestamp parses")

# --- filters are the list's filters ----------------------------------------
for label, params in [
    ("source=upload", {"source": "upload"}),
    ("source=generated", {"source": "generated"}),
    ("source=app", {"source": "app"}),
    ("source=imported", {"source": "imported"}),
    ("starred=true", {"starred": "true"}),
    ("starred=false", {"starred": "false"}),
    ("tag=1", {"tag": 1}),
    ("q=cat", {"q": "cat"}),
    ("q=cats (tag name)", {"q": "cats"}),
    ("source=upload+q=cat", {"source": "upload", "q": "cat"}),
    ("q=no-such-thing", {"q": "no-such-thing"}),
]:
    tf = timeline(**params)
    lf = listing(**params)
    check(tf["total"] == lf["total"], f"filter {label}: timeline total == list total ({tf['total']})")
    ids_f = [i["id"] for i in lf["images"]]
    for d in tf["days"]:
        first = get("/api/images", limit=1, offset=d["first_index"], **params).json()["images"][0]
        check(day_of(first["created_at"]) == d["day"] or d["day"] == "unknown",
              f"filter {label}: first_index of {d['day']} correct")
    check(sorted(d["first_index"] for d in tf["days"]) == sorted(set(d["first_index"] for d in tf["days"])),
          f"filter {label}: first_index values distinct")
    _ = ids_f
check(timeline(source="app")["total"] == 1 and timeline(source="imported")["total"] == 1,
      "app/imported split by generation source")
check(timeline(q="no-such-thing")["days"] == [], "empty result -> no days")

# --- tz: a day boundary moves images to the neighbouring local day ---------
# id 1 = 2025-12-31 23:30 UTC. UTC+1 -> 2026-01-01 00:30; UTC-5 -> still 12-31.
utc = by_day(timeline())
east = by_day(timeline(tz=60))
west = by_day(timeline(tz=-300))
check("2025-12-31" in utc and utc["2025-12-31"]["count"] == 1, "tz=0: id 1 on 2025-12-31")
check("2025-12-31" not in east and east["2026-01-01"]["count"] == 3, "tz=+60: id 1 moves to 2026-01-01")
check("2025-12-31" in west, "tz=-300: id 1 stays on 2025-12-31")
check(by_day(timeline(tz=-300)).get("2026-03-14", {}).get("count") == 3
      and "2026-03-13" not in by_day(timeline(tz=-300)),
      "tz=-300: 08:00Z (03:00 local) stays on 03-14")
tz_pos = by_day(timeline(tz=-600))  # 08:00Z/09:00Z -> 22:00/23:00 the day before; 10:00Z -> 00:00
check(tz_pos.get("2026-03-13", {}).get("count") == 2 and tz_pos["2026-03-14"]["count"] == 1,
      "tz=-600: 08:00Z and 09:00Z fall on the previous day, 10:00Z stays")
check(timeline(tz=60)["total"] == 11 and timeline(tz=-600)["total"] == 11, "tz never changes the total")
check(get("/api/images/timeline", tz=99999).status_code == 422, "absurd tz rejected")

# --- /ids -------------------------------------------------------------------
r = get("/api/images/ids").json()
check(r["ids"] == ids_in_order and r["total"] == 11, "ids: full list in list order")
r = get("/api/images/ids", offset=2, limit=3).json()
check(r["ids"] == ids_in_order[2:5], "ids: offset/limit window equals list slice")
r = get("/api/images/ids", offset=100).json()
check(r["ids"] == [] and r["total"] == 11, "ids: offset past end -> empty, total kept")
r = get("/api/images/ids", source="upload", starred="true").json()
check(r["ids"] == [i["id"] for i in listing(source="upload", starred="true")["images"]],
      "ids: filters match the list")
check(get("/api/images/ids", limit=5000).status_code == 200, "ids: limit 5000 accepted")
check(get("/api/images/ids", limit=5001).status_code == 422, "ids: limit 5001 rejected")
check(get("/api/images/ids", limit=0).status_code == 422, "ids: limit 0 rejected")
check(get("/api/images/ids", offset=-1).status_code == 422, "ids: negative offset rejected")
check(get("/api/images/lookup", ids="1,2").status_code == 200, "lookup route not shadowed")

if failures:
    print(f"\nTIMELINE CHECK FAIL ({len(failures)})")
    sys.exit(1)
print("\nTIMELINE CHECK PASS")
