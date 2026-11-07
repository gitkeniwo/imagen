#!/usr/bin/env python3
"""Series backend checks against a throwaway data directory.

Builds a pre-series database (old schema, no ``series`` table or
``series_id`` columns), migrates it twice, then exercises the Series API
in-process with FastAPI's TestClient. No provider is called.

    uv run --project backend python desktop/scripts/check_series.py

Optional ``--data-dir DIR`` migrates and checks a copy you made yourself
(for example of a test library); the directory must not be backend/data.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REAL_DATA = (REPO / "backend" / "data").resolve()

parser = argparse.ArgumentParser()
parser.add_argument("--data-dir")
args = parser.parse_args()

if args.data_dir:
    data_dir = Path(args.data_dir).expanduser().resolve()
    if data_dir == REAL_DATA or REAL_DATA in data_dir.parents:
        sys.exit("refusing to touch backend/data")
    fresh = False
else:
    data_dir = Path(tempfile.mkdtemp(prefix="imagen-series-"))
    fresh = True
os.environ["IMAGEN_DATA_DIR"] = str(data_dir)
sys.path.insert(0, str(REPO / "backend"))

from app import db  # noqa: E402

failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def seed_legacy() -> None:
    """Old schema + a few rows, the way a pre-series library looks."""
    (data_dir / "images").mkdir(parents=True, exist_ok=True)
    (data_dir / "thumbs").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db.DB_PATH)
    conn.executescript(db.SCHEMA.split("-- Two-level grouping")[0])
    now = "2026-11-01T10:00:00.000000+00:00"
    for i in range(1, 6):
        conn.execute(
            "INSERT INTO images (sha256, filename, mime, width, height, byte_size, source, file_path, thumb_path, created_at) "
            "VALUES (?, ?, 'image/png', 2, 3, 10, 'generated', ?, ?, ?)",
            (f"{i:064d}", f"img{i}.png", f"images/{i}.png", f"thumbs/{i}.webp", now),
        )
    rows = [
        ("poster v1", "blocked", None, "2026-11-01T09:59:00.000000+00:00"),
        ("poster v1", "success", 1, "2026-11-01T10:00:00.000000+00:00"),
        ("poster v2", "success", 2, "2026-11-01T10:05:00.000000+00:00"),
        ("poster v2", "blocked", None, "2026-11-01T10:06:00.000000+00:00"),
        ("poster v3", "error", None, "2026-11-01T10:07:00.000000+00:00"),
        ("poster v3", "aborted", None, "2026-11-01T10:08:00.000000+00:00"),
        ("old note", "note", None, "2026-11-01T09:00:00.000000+00:00"),
        ("poster v2", "error", None, "2026-11-01T10:09:00.000000+00:00"),
        ("unrelated", "success", 3, "2026-11-01T11:00:00.000000+00:00"),
    ]
    for prompt, status, out, at in rows:
        conn.execute(
            "INSERT INTO generations (prompt, model, aspect_ratio, resolution, status, output_image_id, created_at, source, provider) "
            "VALUES (?, 'gemini-3-pro-image', '2:3', '1K', ?, ?, ?, 'vertex', 'vertex')",
            (prompt, status, out, at),
        )
    conn.execute("INSERT INTO tags (name, created_at) VALUES ('client:maison', ?)", (now,))
    conn.execute("INSERT INTO image_tags (image_id, tag_id) VALUES (1, 1), (2, 1)")
    conn.commit()
    conn.close()


if fresh:
    seed_legacy()

# --- migration: twice, idempotent ------------------------------------------
db.init_storage()
db.init_storage()
with db.get_conn() as conn:
    gcols = {r["name"] for r in conn.execute("PRAGMA table_info(generations)")}
    dcols = {r["name"] for r in conn.execute("PRAGMA table_info(drafts)")}
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    idx = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
check("series" in tables, "migration creates series table")
check("series_id" in gcols and "series_id" in dcols, "migration adds series_id columns")
check({"idx_generations_series_id", "idx_drafts_series_id"} <= idx, "series_id indexes exist")

if not fresh:
    with db.get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) c FROM generations WHERE series_id IS NOT NULL").fetchone()["c"]
    print(f"     existing library migrated; {n} records already in a series")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app, base_url="http://127.0.0.1")


def ok(res, label: str, code: int = 200):
    check(res.status_code == code, f"{label} -> {res.status_code}")
    return res.json() if res.headers.get("content-type", "").startswith("application/json") else None


theme = ok(c.post("/api/series", json={"kind": "theme", "name": "Autumn campaign"}), "create theme")
s1 = ok(c.post("/api/series", json={"name": "Perfume poster", "parentId": theme["id"]}), "create series in theme")
s2 = ok(c.post("/api/series", json={"name": "Perfume poster"}), "same name under No theme is allowed")
ok(c.post("/api/series", json={"name": "perfume POSTER", "parentId": theme["id"]}), "case-insensitive clash", 409)
ok(c.post("/api/series", json={"name": "x", "parentId": s1["id"]}), "parent must be a theme", 400)
ok(c.post("/api/series", json={"kind": "theme", "name": "t", "parentId": theme["id"]}), "theme has no parent", 400)

if fresh:
    gens = {g["prompt"] + g["status"]: g["id"] for g in c.get("/api/generations?limit=50").json()["generations"]}
    ids = [g for k, g in gens.items() if k.startswith("poster")]
    r = ok(c.post(f"/api/series/{s1['id']}/assign", json={"generationIds": ids}), "assign")
    check(r["moved"] == 0, "assign: nothing moved yet")
    r = ok(c.post(f"/api/series/{s2['id']}/assign", json={"generationIds": ids[:2]}), "move two")
    check(r["moved"] == 2, "assign into another series reports moved=2")
    ok(c.post(f"/api/series/{theme['id']}/assign", json={"generationIds": ids}), "assign to theme refused", 400)
    ok(c.post(f"/api/series/{s1['id']}/assign", json={"generationIds": ids[:2]}), "move back")

    tree = ok(c.get("/api/series?archived=0"), "tree")
    node = tree["themes"][0]["series"][0]
    hist = c.get(f"/api/generations?series={s1['id']}&limit=50").json()
    statuses = [g["status"] for g in hist["generations"]]
    check(node["tries"] == sum(1 for s in statuses if s in ("success", "blocked", "error", "aborted")),
          "tries match History rows for the series")
    check((node["success"], node["blocked"], node["error"], node["aborted"]) == (2, 2, 2, 1),
          f"status counts (got {node['success']},{node['blocked']},{node['error']},{node['aborted']})")
    err_hist = c.get(f"/api/generations?series={s1['id']}&status=error").json()["total"]
    check(err_hist == node["error"] + node["aborted"], "History 'error' filter = error + aborted")
    check(tree["themes"][0]["tries"] == node["tries"], "theme sums its series")
    check(len(node["strip"]) == node["tries"], "status strip has every finished try")
    check(len(node["cover"]) == 2, "cover = 2 successful outputs")

    tl = ok(c.get(f"/api/series/{s1['id']}/generations"), "timeline")
    seqs = [g["seq"] for g in tl["generations"]]
    check(seqs == sorted(seqs, reverse=True) and seqs[-1] == 1, "timeline newest first, seq from 1")
    check(tl["generations"][-1]["previous"] is None and tl["generations"][0]["previous"]["seq"] == seqs[0] - 1,
          "timeline rows carry the previous attempt")
    tlb = ok(c.get(f"/api/series/{s1['id']}/generations?status=blocked"), "timeline filter")
    check(tlb["total"] == 2 and all((g["previous"] is not None) == (g["seq"] > 1) for g in tlb["generations"]),
          "filtered rows still diff against their time-previous attempt")
    check(c.get(f"/api/generations?series=none").json()["total"] == 1, "History 'No series' filter")

    # best image + purge
    ok(c.patch(f"/api/series/{s1['id']}", json={"bestImageId": 2}), "set best")
    d = ok(c.get(f"/api/series/{s1['id']}"), "detail")
    check(d["cover"][0]["id"] == 2 and d["best_image"]["id"] == 2, "best image leads the cover")
    with db.get_conn() as conn:
        from app.routes.images import _purge
        _purge(conn, dict(conn.execute("SELECT * FROM images WHERE id = 2").fetchone()))
    d = ok(c.get(f"/api/series/{s1['id']}"), "detail after purge")
    check(d["best_image_id"] is None, "purging the best image clears best_image_id")

    # generate / manual / drafts validation
    ok(c.post("/api/generations/manual", json={"model": "gemini-3-pro-image", "status": "blocked", "seriesId": theme["id"]}),
       "manual with a theme id refused", 400)
    m = ok(c.post("/api/generations/manual", json={"model": "gemini-3-pro-image", "status": "blocked", "seriesId": s1["id"]}),
           "manual with series")
    check(m["series_id"] == s1["id"], "manual record stores series_id")
    m2 = ok(c.patch(f"/api/generations/{m['id']}", json={"model": "gemini-3-pro-image", "status": "error", "prompt": "edited"}),
            "edit without seriesId")
    check(m2["series_id"] == s1["id"], "PATCH without seriesId keeps the series")
    gen_unknown = c.post("/api/generate", json={"model": "gemini-3-pro-image", "provider": "vertex", "seriesId": 99999})
    check(400 <= gen_unknown.status_code < 500, f"generate with an unknown series is a 4xx ({gen_unknown.status_code})")
    gen_bad = c.post("/api/generate", json={"model": "gemini-3-pro-image", "provider": "vertex", "seriesId": theme["id"]})
    check(400 <= gen_bad.status_code < 500, f"generate with a theme id is a 4xx ({gen_bad.status_code})")
    dr = ok(c.post("/api/drafts", json={"prompt": "p", "seriesId": s1["id"]}), "draft with series")
    check(dr["series_id"] == s1["id"], "draft stores series_id")
    dr = ok(c.patch(f"/api/drafts/{dr['id']}", json={"seriesId": None}), "draft clear series")
    check(dr["series_id"] is None, "draft PATCH null clears series_id")
    ok(c.patch(f"/api/drafts/{dr['id']}", json={"seriesId": theme["id"]}), "draft with theme refused", 400)

    # import from tag
    pv = ok(c.get("/api/series/import/preview?tag=1"), "import preview")
    check(pv["found"] == 1 and pv["inOtherSeries"] == 1, f"preview counts tagged gens ({pv})")
    check(pv["failedSamePrompt"] >= 1, "preview finds same-prompt failures")
    imp = ok(c.post("/api/series/import", json={"tagId": 1, "name": "Maison", "includeFailed": True}), "import commit")
    check(imp["assigned"] == pv["found"] + pv["failedSamePrompt"], "import assigns tagged + failed")

    # membership (Library)
    mem = ok(c.get("/api/series/membership?imageIds=1,4"), "membership")
    by = {i["imageId"]: i for i in mem["items"]}
    check(by[1]["generationIds"] and by[4]["generationIds"] == [], "upload without generation has none")

    # unassign / delete series / delete theme
    ok(c.post("/api/series/unassign", json={"generationIds": ids[:1]}), "unassign")
    with db.get_conn() as conn:
        check(conn.execute("SELECT series_id FROM generations WHERE id = ?", (ids[0],)).fetchone()[0] is None,
              "unassign clears series_id")
    before = c.get("/api/generations?limit=200").json()["total"]
    s3 = ok(c.post("/api/series", json={"name": "Perfume poster (theme child)", "parentId": theme["id"]}), "series 3")
    # Move s2 ("Perfume poster", No theme) – then deleting the theme must rename s1.
    ok(c.delete(f"/api/series/{theme['id']}"), "delete theme")
    tree = c.get("/api/series").json()
    names = sorted(s["name"] for s in tree["unthemed"])
    check(tree["themes"] == [] and "Perfume poster (2)" in names, f"theme delete moves series to No theme ({names})")
    ok(c.delete(f"/api/series/{s1['id']}"), "delete series")
    after = c.get("/api/generations?limit=200").json()["total"]
    check(before == after, "deleting a series keeps every generation")
    with db.get_conn() as conn:
        check(conn.execute("SELECT COUNT(*) FROM generations WHERE series_id = ?", (s1["id"],)).fetchone()[0] == 0,
              "deleting a series clears series_id")
    ok(c.patch(f"/api/series/{s3['id']}", json={"archived": True}), "archive")
    check(all(s["id"] != s3["id"] for s in c.get("/api/series?archived=0").json()["unthemed"]), "archived hidden in active")
    check(any(s["id"] == s3["id"] for s in c.get("/api/series?archived=1").json()["unthemed"]), "archived listed")
    with db.get_conn() as conn:
        try:
            conn.execute("UPDATE generations SET series_id = ? WHERE id = 1", (theme["id"],))
            check(False, "trigger blocks theme ids")
        except sqlite3.DatabaseError:
            check(True, "trigger blocks non-series ids")

print(f"\n{len(failures)} failure(s)" if failures else "\nall series checks passed")
print(f"data dir: {data_dir}")
sys.exit(1 if failures else 0)
