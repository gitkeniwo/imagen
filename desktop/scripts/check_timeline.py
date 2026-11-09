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
conn.execute(
    "INSERT INTO series (kind, parent_id, name, created_at, updated_at) "
    "VALUES ('series', NULL, 'timeline-series', '2026-01-01T00:00:00+00:00', "
    "'2026-01-01T00:00:00+00:00')"
)
GENERATIONS = [
    # prompt, model, status, output, created, source, provider, series
    ("alpha running", "gemini-3-pro-image", "running", None,
     "2026-04-01T10:00:00.000001+00:00", "vertex", "gemini", None),
    ("alpha blocked", "gemini-3-pro-image", "blocked", 5,
     "2026-02-10T10:00:00.000002+00:00", "vertex", "vertex", None),
    ("beta error old", "gemini-3-pro-image", "error", 3,
     "2026-03-01T10:00:00.000003+00:00", "manual", "gemini", None),
    ("gamma aborted", "gemini-3-pro-image", "aborted", None,
     "2026-03-01T11:00:00.000004+00:00", "vertex", "vertex", None),
    ("legacy note", "gemini-3-pro-image", "note", 4,
     "2026-05-01T10:00:00.000005+00:00", "vertex", "vertex", None),
    ("series success", "gemini-2.5-flash-image", "success", 5,
     "2026-04-12T10:00:00.000006+00:00", "vertex", "vertex", 1),
    ("stray old date high id", "gemini-2.5-flash-image", "success", 1,
     "2025-12-01T10:00:00.000007+00:00", "manual", "vertex", None),
    ("bad generation date", "gemini-3-pro-image", "success", 2,
     "not a date", "vertex", "vertex", None),
]
for prompt, model, status, output, created, source, provider, series_id in GENERATIONS:
    conn.execute(
        "INSERT INTO generations "
        "(prompt, model, status, output_image_id, created_at, source, provider, series_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (prompt, model, status, output, created, source, provider, series_id),
    )
DRAFTS = [
    # prompt, pinned, updated_at
    ("Pinned A", 1, "2026-04-01T10:00:00.000001+00:00"),
    ("Pinned B", 1, "2025-01-01T10:00:00.000002+00:00"),
    ("Draft C", 0, "2026-03-10T10:00:00.000003+00:00"),
    ("Draft D", 0, "2026-02-01T10:00:00.000004+00:00"),
    ("Draft E", 0, "2026-03-10T11:00:00.000005+00:00"),
    ("Draft bad date", 0, "not a date"),
    ("Draft old", 0, "2024-12-31T10:00:00.000007+00:00"),
    ("Draft oldest", 0, "2024-01-01T10:00:00.000008+00:00"),
]
for prompt, pinned, updated in DRAFTS:
    conn.execute(
        "INSERT INTO drafts "
        "(prompt, model, output_format, pinned, created_at, updated_at, provider) "
        "VALUES (?, 'gemini-3-pro-image', 'image/jpeg', ?, ?, ?, 'vertex')",
        (prompt, pinned, updated, updated),
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
check(timeline(source="app")["total"] == 3 and timeline(source="imported")["total"] == 3,
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

# --- generation history: shared filters, runs and ids ----------------------


def gen_listing(**params) -> dict:
    res = get("/api/generations", limit=200, **params)
    check(res.status_code == 200, f"generations list {params} -> {res.status_code}")
    return res.json()


def gen_timeline(**params) -> dict:
    res = get("/api/generations/timeline", **params)
    check(res.status_code == 200, f"generations timeline {params} -> {res.status_code}")
    return res.json()


def gen_day(g: dict) -> str:
    created = g.get("created_at") or ""
    canonical = (
        len(created) == 32
        and created[10] == "T"
        and created[19] == "."
        and created.endswith("+00:00")
    )
    return day_of(created) if canonical else "unknown"


gt = gen_timeline()
gl = gen_listing()
check(gt["total"] == gl["total"] == 9, f"generations total matches list ({gt['total']} vs {gl['total']}); note hidden")
check(sum(d["count"] for d in gt["days"]) == gt["total"], "generation day counts add up")
gids = [g["id"] for g in gl["generations"]]
check(gids.index(9) > gids.index(4),
      "out-of-order generation date follows the list order, not id")
check(any(d["day"] == "unknown" for d in gt["days"]),
      "unparseable generation date is grouped as unknown")
gruns = {start: day for start, day in gt["runs"]}
gstarts = sorted(gruns)
for pos, generation in enumerate(gl["generations"]):
    k = max(i for i, start in enumerate(gstarts) if start <= pos)
    check(gruns[gstarts[k]] == gen_day(generation),
          f"generation runs: position {pos} is {gen_day(generation)}")

for label, params in [
    ("q=alpha", {"q": "alpha"}),
    ("status=error", {"status": "error"}),
    ("status=success", {"status": "success"}),
    ("kind=manual", {"kind": "manual"}),
    ("starred=true", {"starred": "true"}),
    ("with_output=true", {"with_output": "true"}),
    ("series=1", {"series": 1}),
    ("series=none", {"series": "none"}),
    ("provider=gemini", {"provider": "gemini"}),
    ("model=flash", {"model": "gemini-2.5-flash-image"}),
    ("q=no-such-generation", {"q": "no-such-generation"}),
]:
    tf = gen_timeline(**params)
    lf = gen_listing(**params)
    check(tf["total"] == lf["total"], f"generation filter {label}: totals match")
    ids_f = [g["id"] for g in lf["generations"]]
    id_res = get("/api/generations/ids", **params).json()
    check(id_res["ids"] == ids_f and id_res["total"] == lf["total"],
          f"generation filter {label}: ids match list")
    for d in tf["days"]:
        first = get("/api/generations", limit=1, offset=d["first_index"], **params).json()["generations"][0]
        check(gen_day(first) == d["day"], f"generation filter {label}: first_index {d['first_index']} lands on {d['day']}")

gids_all = [g["id"] for g in gl["generations"]]
r = get("/api/generations/ids", offset=2, limit=3).json()
check(r["ids"] == gids_all[2:5], "generation ids: offset/limit window equals list slice")
r = get("/api/generations/ids", q="alpha").json()
check(r["ids"] == [g["id"] for g in gen_listing(q="alpha")["generations"]],
      "generation ids: filters match the list")
check(get("/api/generations/ids", limit=5000).status_code == 200,
      "generation ids: limit 5000 accepted")
check(get("/api/generations/ids", limit=5001).status_code == 422,
      "generation ids: limit 5001 rejected")
check(get("/api/generations/timeline", status="nope").status_code == 400,
      "generation timeline: invalid status rejected")
check(get("/api/generations/timeline", tz=99999).status_code == 422,
      "generation timeline: absurd tz rejected")

# --- drafts: pinned prefix + updated_at calendar section ------------------


def draft_listing(**params) -> dict:
    res = get("/api/drafts", limit=200, **params)
    check(res.status_code == 200, f"drafts list {params} -> {res.status_code}")
    return res.json()


def draft_timeline(**params) -> dict:
    res = get("/api/drafts/timeline", **params)
    check(res.status_code == 200, f"drafts timeline {params} -> {res.status_code}")
    return res.json()


dt = draft_timeline()
dl = draft_listing()
check(dt["pinned"] == 2 and dt["total"] == dl["total"] == 8,
      f"draft timeline: pinned/total ({dt['pinned']}/{dt['total']})")
check([d["id"] for d in dl["drafts"][:2]] == [1, 2],
      "draft list: pinned records come first by updated_at")
check(sum(d["count"] for d in dt["days"]) == 6,
      "draft calendar counts exclude the pinned prefix")
check(all(d["first_index"] >= 2 for d in dt["days"]),
      "draft day indexes start after the pinned prefix")
check(dt["runs"] and dt["runs"][0][0] == 2,
      "draft runs start at the first non-pinned record")
check(any(d["day"] == "unknown" for d in dt["days"]),
      "unparseable draft updated_at is grouped as unknown")

drafts_by_position = dl["drafts"]
druns = {start: day for start, day in dt["runs"]}
dstarts = sorted(druns)
for pos, draft in enumerate(drafts_by_position[2:], start=2):
    k = max(i for i, start in enumerate(dstarts) if start <= pos)
    expected = day_of(draft.get("updated_at"))
    check(druns[dstarts[k]] == expected,
          f"draft runs: position {pos} is {expected}")

for label, params in [
    ("q=Pinned", {"q": "Pinned"}),
    ("q=Draft", {"q": "Draft"}),
    ("q=none", {"q": "nothing-matches"}),
]:
    tf = draft_timeline(**params)
    lf = draft_listing(**params)
    check(tf["total"] == lf["total"], f"draft filter {label}: totals match")
    check(tf["pinned"] == sum(1 for d in lf["drafts"] if d["pinned"]),
          f"draft filter {label}: pinned count matches")
check(draft_timeline(q="Pinned")["days"] == [],
      "pinned-only draft result has no calendar days")
check(get("/api/drafts/timeline", tz=99999).status_code == 422,
      "draft timeline: absurd tz rejected")

if failures:
    print(f"\nTIMELINE CHECK FAIL ({len(failures)})")
    sys.exit(1)
print("\nTIMELINE CHECK PASS")
