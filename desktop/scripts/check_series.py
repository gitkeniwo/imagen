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
check("series_marks" in tables, "migration creates series_marks table")
check("series_id" in gcols and "series_id" in dcols, "migration adds series_id columns")
check({"idx_generations_series_id", "idx_drafts_series_id"} <= idx, "series_id indexes exist")

check("series_pos" in gcols and "idx_generations_series_pos" in idx, "migration adds series_pos + index")

# --- series-v2 B2: series_pos backfill on a pre-B2 database ----------------
if fresh:
    with db.get_conn() as conn:
        bf = conn.execute(
            "INSERT INTO series (kind, name, created_at, updated_at) VALUES ('series', 'Backfill', ?, ?)",
            ("2026-11-01T00:00:00.000000+00:00",) * 2,
        ).lastrowid
        # Strip B2 back off: triggers, index, column.
        conn.execute("DROP TRIGGER trg_generations_series_pos_insert")
        conn.execute("DROP TRIGGER trg_generations_series_pos_update")
        conn.execute("DROP INDEX idx_generations_series_pos")
        conn.execute("ALTER TABLE generations DROP COLUMN series_pos")
        conn.execute("UPDATE generations SET series_id = ? WHERE prompt LIKE 'poster%'", (bf,))
    db.init_storage()

    def bf_rows():
        with db.get_conn() as conn:
            return [tuple(r) for r in conn.execute(
                f"SELECT id, series_pos FROM generations WHERE series_id = ? ORDER BY {db.GENERATION_SORT_AT}, id",
                (bf,),
            ).fetchall()]

    first = bf_rows()
    check([p for _, p in first] == [1024.0 * (i + 1) for i in range(len(first))],
          f"backfill numbers each series ROW_NUMBER * 1024 in time order ({[p for _, p in first]})")
    db.init_storage()
    check(bf_rows() == first, "backfill is idempotent (second run changes nothing)")
    with db.get_conn() as conn:
        conn.execute("UPDATE generations SET series_pos = 0.5 WHERE id = ?", (first[-1][0],))
        conn.execute("UPDATE generations SET series_pos = NULL WHERE id = ?", (first[2][0],))
    db.init_storage()
    rows = dict(bf_rows())
    check(rows[first[-1][0]] == 0.5, "a later migration keeps existing (custom) positions")
    check(rows[first[2][0]] == (first[1][1] + first[3][1]) / 2,
          "a stray row without a position is placed by the time rule")
    with db.get_conn() as conn:
        conn.execute("UPDATE generations SET series_id = NULL WHERE series_id = ?", (bf,))
        conn.execute("DELETE FROM series WHERE id = ?", (bf,))
        check(conn.execute("SELECT COUNT(*) FROM generations WHERE series_id IS NULL AND series_pos IS NOT NULL").fetchone()[0] == 0,
              "clearing series_id clears series_pos (trigger)")

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

# --- series-v2 B2: order, reorder, versions ---------------------------------
import json  # noqa: E402

from app import series_order  # noqa: E402

fixture = json.loads((REPO / "frontend/scripts/fixtures/version-key.json").read_text("utf-8"))


def vk(a: dict) -> str:
    return series_order.version_key(a["prompt"], a["model"], a["resolution"], a["aspect_ratio"], a["input_ids"])


check(all(vk(k["attempt"]) == k["key"] for k in fixture["keys"]),
      "version_key matches the shared fixture byte for byte")
bad = [p["name"] for p in fixture["pairs"] if (vk(p["a"]) == vk(p["b"])) != p["same"]]
check(not bad, f"version_key same/different pairs ({bad})")

if fresh:
    def at(minute: int) -> str:
        return f"2026-11-02T10:{minute:02d}:00.000000+00:00"

    def manual(sid, minute, prompt="p", status="blocked", **extra):
        body = {"model": "gemini-3-pro-image", "status": status, "prompt": prompt,
                "aspectRatio": "2:3", "resolution": "1K", "createdAt": at(minute), **extra}
        if sid is not None:
            body["seriesId"] = sid
        r = c.post("/api/generations/manual", json=body)
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def order(sid):
        rows = c.get(f"/api/series/{sid}/generations?limit=200").json()["generations"]
        return [g["id"] for g in reversed(rows)]

    def positions(sid):
        with db.get_conn() as conn:
            return [r[0] for r in conn.execute(
                "SELECT series_pos FROM generations WHERE series_id = ? ORDER BY series_pos, id", (sid,)
            ).fetchall()]

    def reorder(sid, ids, code=200, **target):
        return ok(c.post(f"/api/series/{sid}/reorder", json={"generationIds": ids, **target}),
                  f"reorder {ids} {target}", code)

    lab = ok(c.post("/api/series", json={"name": "Order lab"}), "create order lab")["id"]
    A, C, E = manual(lab, 0), manual(lab, 20), manual(lab, 40)
    check(order(lab) == [A, C, E], "records filed in time order")
    B = manual(lab, 10)
    check(order(lab) == [A, B, C, E], "manual record with an older time is inserted by time")
    check(not c.get(f"/api/series/{lab}").json()["order_custom"], "time order: order_custom false")

    r = reorder(lab, [E], before=A)
    check(order(lab) == [E, A, B, C], "reorder: before")
    check(r["order_custom"] and {x["id"] for x in r["changed"]} == {E, A, B, C}
          and next(x for x in r["changed"] if x["id"] == E) == {"id": E, "seq": 1, "old_seq": 4},
          "reorder returns order_custom and every changed #N")
    check(c.get(f"/api/series/{lab}").json()["order_custom"], "detail order_custom after a move")
    D = manual(None, 30)
    ok(c.post(f"/api/series/{lab}/assign", json={"generationIds": [D]}), "assign D")
    check(order(lab) == [E, A, B, C, D], "assign: after the furthest older record (C), not at the end")
    reorder(lab, [C], before=A)
    F = manual(None, 15)
    ok(c.post(f"/api/series/{lab}/assign", json={"generationIds": [F]}), "assign F")
    check(order(lab) == [E, C, A, B, F, D],
          "import into a custom order: right after the last-placed older record (B)")

    # /api/generate (rerun / reuse included) always appends.
    from app import providers as P  # noqa: E402
    from app.routes import generate as G  # noqa: E402

    class _FakeProvider:
        ID = "vertex"
        LABEL = "Fake"

        @staticmethod
        async def generate(**_kw):
            return P.GenResult(status="blocked", message="fake", raw_finish="SAFETY")

    G._validate_provider = lambda body: (_FakeProvider, P.model_spec("vertex", body.model), body.resolution)
    res = c.post("/api/generate", json={"model": "gemini-3-pro-image", "provider": "vertex", "prompt": "p",
                                        "seriesId": lab, "aspectRatio": "2:3", "resolution": "1K"})
    check(res.status_code == 200 and json.loads(res.text)["status"] == "blocked", "fake generate in series")
    Gn = order(lab)[-1]
    check(Gn not in (A, B, C, D, E, F) and len(order(lab)) == 7, "new generation goes last")
    res = c.post("/api/generate", json={"model": "gemini-3-pro-image", "provider": "vertex", "prompt": "x"})
    with db.get_conn() as conn:
        check(conn.execute("SELECT series_pos FROM generations ORDER BY id DESC LIMIT 1").fetchone()[0] is None,
              "generation without a series has no series_pos")

    reorder(lab, [F, A], after=Gn)
    check(order(lab) == [E, C, B, D, Gn, A, F], "block keeps its current relative order (A before F)")
    reorder(lab, [E, C], before=B)
    check(order(lab) == [E, C, B, D, Gn, A, F], "moving a block next to itself is a no-op")
    reorder(lab, [A], 400, before=A)
    reorder(lab, [A], 400, before=B, after=C)
    reorder(lab, [A], 400)
    reorder(lab, [], 400, before=B)
    reorder(lab, [A], 400, before=999999)
    reorder(lab, [999999], 400, before=B)
    ok(c.post("/api/series/999999/reorder", json={"generationIds": [A], "before": B}),
       "reorder in an unknown series", 404)

    hist = [g["id"] for g in c.get(f"/api/generations?series={lab}&limit=50").json()["generations"]]
    with db.get_conn() as conn:
        by_time = [r[0] for r in conn.execute(
            f"SELECT id FROM generations WHERE series_id = ? ORDER BY {db.GENERATION_SORT_AT} DESC, id DESC", (lab,)
        ).fetchall()]
    check(hist == by_time, "History keeps time order inside a series")

    # reset + restore (undo)
    custom = order(lab)
    r = ok(c.post(f"/api/series/{lab}/reorder/reset"), "reset")
    check(r["previous_order"] == custom and not r["order_custom"], "reset returns previous_order")
    check(order(lab) == list(reversed(by_time)), "reset = time order")
    ok(c.post("/api/series/unassign", json={"generationIds": [D]}), "unassign D")
    H = manual(lab, 5)
    r = ok(c.post(f"/api/series/{lab}/reorder/restore", json={"generationIds": custom}), "restore")
    expect = [x for x in custom if x != D]
    # H (10:05) is new since the reset: placed after the furthest older record, A.
    expect.insert(expect.index(A) + 1, H)
    check(order(lab) == expect and r["order_custom"], f"restore: gone ids ignored, new ones by time ({order(lab)} vs {expect})")
    db.init_storage()
    check(order(lab) == expect, "custom order survives another migration run")

    # #N agrees between the timeline and the versions endpoint.
    seq_tl = {g["id"]: g["seq"] for g in c.get(f"/api/series/{lab}/generations?limit=200").json()["generations"]}
    seq_v = {a["id"]: a["seq"] for v in c.get(f"/api/series/{lab}/versions?limit=100").json()["versions"] for a in v["attempts"]}
    check(seq_tl == seq_v and seq_tl[expect[0]] == 1, "seq: timeline == versions, #1 = first in order")
    tl = c.get(f"/api/series/{lab}/generations?limit=200").json()["generations"]
    check(all((g["previous"] or {}).get("id") == (expect[expect.index(g["id"]) - 1] if expect.index(g["id"]) else None)
              for g in tl), "previous follows the series order")

    # renumbering when a gap gets too small
    rn = ok(c.post("/api/series", json={"name": "Renumber"}), "create renumber series")["id"]
    X, Y, Z = manual(rn, 0), manual(rn, 1), manual(rn, 2)
    sim = [X, Y, Z]
    renumbered = False
    for _ in range(45):
        last = sim[-1]
        reorder(rn, [last], after=X)
        sim.remove(last)
        sim.insert(1, last)
        pos = positions(rn)
        renumbered |= pos == [1024.0, 2048.0, 3072.0]
        if min(b - a for a, b in zip(pos, pos[1:])) < db.SERIES_POS_EPSILON:
            break
    check(order(rn) == sim, "order stays right across repeated midpoint moves")
    check(renumbered and min(b - a for a, b in zip(positions(rn), positions(rn)[1:])) >= db.SERIES_POS_EPSILON,
          "tight gaps are renumbered n * 1024")

    # versions
    vs = ok(c.post("/api/series", json={"name": "Versions"}), "create versions series")["id"]
    v_ids = [
        manual(vs, 0, "p1"), manual(vs, 1, "p1 "),                        # v1
        manual(vs, 2, "p2", status="error", errorMessage="x"), manual(vs, 3, " p2"),  # v2
        manual(vs, 4, "p1"),                                              # v3 (not merged with v1)
        manual(vs, 5, "p1", resolution="2K"),                             # v4
    ]

    def versions(sid, q=""):
        return c.get(f"/api/series/{sid}/versions?limit=100{q}").json()

    def shape(sid):
        return [[a["id"] for a in v["attempts"]] for v in reversed(versions(sid)["versions"])]

    vv = versions(vs)
    check(shape(vs) == [v_ids[0:2], v_ids[2:4], v_ids[4:5], v_ids[5:6]],
          "versions: consecutive same config merges, only neighbors")
    v4, v3, v2, v1 = vv["versions"]
    check([v["version"] for v in vv["versions"]] == [4, 3, 2, 1] and vv["total"] == 4, "newest version first")
    check(v1["base_version"] is None and v4["base_version"] == 3, "base_version = previous version")
    check(v4["changed_params"] == ["resolution"] and not v4["prompt_changed"] and v2["prompt_changed"],
          "changed_params / prompt_changed vs the previous version")
    check((v2["first_seq"], v2["last_seq"]) == (3, 4) and v2["counts"]["error"] == 1 and v2["counts"]["all"] == 2,
          "first/last seq and counts")
    check(v1["key"] == series_order.version_key("p1", "gemini-3-pro-image", "1K", "2:3", []), "key = version_key")
    fv = versions(vs, "&status=error")["versions"]
    hidden = [v["version"] for v in fv if v["hidden"]]
    check(hidden == [4, 3, 1] and all(v["attempts"] == [] and v["counts"]["all"] > 0 for v in fv if v["hidden"]),
          "filter: versions with no match come back hidden, with counts")
    check([a["id"] for a in fv[2]["attempts"]] == [v_ids[2]] and fv[2]["attempts_total"] == 1
          and fv[0]["base_version"] == 3, "filter only hides attempts; base_version unchanged")
    p1 = c.get(f"/api/series/{vs}/versions?limit=3").json()
    p2 = c.get(f"/api/series/{vs}/versions?limit=3&cursor={p1['next_cursor']}").json()
    check([v["version"] for v in p1["versions"]] == [4, 3, 2] and p1["next_cursor"] == 2
          and [v["version"] for v in p2["versions"]] == [1] and p2["next_cursor"] is None,
          "paged by version via cursor")
    ok(c.get(f"/api/series/{vs}/versions?status=bogus"), "versions bad status", 400)

    # series-v2 B3: what the Changes view needs without a second request.
    check(v4["base_prompt"] == v3["prompt"] and v4["base_params"] == v3["params"]
          and v1["base_prompt"] is None and v1["base_params"] is None,
          "B3: base_prompt / base_params are the baseline's, null for v1")
    check(fv[0]["base_hidden"] and not fv[1]["base_hidden"] and fv[2]["base_hidden"]
          and not any(v["base_hidden"] for v in vv["versions"]),
          "B3: base_hidden only when the filter hides the whole baseline")
    check(all(v["inputs"] == [] for v in vv["versions"]) and "attempts" in v1["attempts"][0],
          "B3: inputs (image rows) and per-attempt API retries are returned")
    pos = c.get("/api/generations/series-position?ids=" + ",".join(map(str, v_ids))).json()["items"]
    check([it["version"] for it in pos] == [1, 1, 2, 2, 3, 4], "B3: series-position reports vK")

    reorder(vs, [v_ids[4]], after=v_ids[1])
    check(shape(vs) == [[v_ids[0], v_ids[1], v_ids[4]], v_ids[2:4], v_ids[5:6]], "moving an attempt merges versions")
    reorder(vs, [v_ids[2]], after=v_ids[5])
    check(shape(vs) == [[v_ids[0], v_ids[1], v_ids[4]], [v_ids[3]], [v_ids[5]], [v_ids[2]]],
          "moving an attempt out splits a version")

    # series-v2 B4: the whole order, small, for the reorder UI.
    om = ok(c.get(f"/api/series/{vs}/order"), "order map")
    check([it["id"] for it in om["items"]] == [g for grp in shape(vs) for g in grp]
          and [it["seq"] for it in om["items"]] == list(range(1, len(om["items"]) + 1))
          and [it["version"] for it in om["items"]] == [1, 1, 1, 2, 3, 4],
          "order map: series order, #N and vK like the versions endpoint")
    check(om["items"][0]["k"] == om["items"][1]["k"] and len(om["keys"]) == len({it["k"] for it in om["items"]})
          and om["order_custom"] is True, "order map: key indexes and order_custom")
    ok(c.get("/api/series/999999/order"), "order map of an unknown series", 404)

    big = ok(c.post("/api/series", json={"name": "Big version"}), "create big series")["id"]
    with db.get_conn() as conn:
        for i in range(205):
            conn.execute(
                "INSERT INTO generations (prompt, model, aspect_ratio, resolution, status, created_at, source, provider, series_id) "
                "VALUES ('same', 'gemini-3-pro-image', '2:3', '1K', 'blocked', ?, 'manual', 'vertex', ?)",
                (f"2026-11-03T10:{i // 60:02d}:{i % 60:02d}.000000+00:00", big),
            )
    bv = versions(big)["versions"]
    check(len(bv) == 1 and bv[0]["attempts_total"] == 205 and len(bv[0]["attempts"]) == 200
          and bv[0]["attempts"][-1]["seq"] == 205, "a version lists at most 200 attempts (the last ones)")

    # --- series-v2 B5: marks, cover fallback, collage and cleanup -------------
    mark_theme = ok(c.post("/api/series", json={"kind": "theme", "name": "Marks theme"}),
                    "create marks theme")["id"]
    marks_id = ok(c.post("/api/series", json={"name": "Marks", "parentId": mark_theme}),
                  "create marks series")["id"]
    # Four live output images give the three-slot collage enough candidates.
    # Image 4 is deliberately not an output yet, for the "output only" check.
    marked = []
    for minute, image_id in [(0, 1), (10, 3), (20, 5)]:
        marked.append(ok(c.post("/api/generations/manual", json={
            "model": "gemini-3-pro-image", "status": "success", "prompt": f"mark p{minute}",
            "createdAt": at(minute), "outputImageId": image_id, "seriesId": marks_id,
        }), f"manual marked output {image_id}")["id"])

    def mark(sid, image_id, kind, code=200):
        return c.put(f"/api/series/{sid}/marks/{image_id}", json={"kind": kind}), code

    def marks_detail(sid=marks_id):
        return c.get(f"/api/series/{sid}").json()

    def mark_rows(sid=marks_id):
        with db.get_conn() as conn:
            return [tuple(r) for r in conn.execute(
                "SELECT image_id, kind FROM series_marks WHERE series_id = ? ORDER BY image_id",
                (sid,),
            ).fetchall()]

    res, code = mark(marks_id, 4, "pick", 400)
    check(res.status_code == code, "marking a non-output image is refused (400)")
    marked.append(ok(c.post("/api/generations/manual", json={
        "model": "gemini-3-pro-image", "status": "success", "prompt": "mark p30",
        "createdAt": at(30), "outputImageId": 4, "seriesId": marks_id,
    }), "manual fourth marked output")["id"])

    d = marks_detail()
    check([im["id"] for im in d["cover"]] == [4, 5, 3]
          and d["best_image"]["id"] == 4 and d["picks"] == 0,
          "cover fallback without marks = newest successful outputs")

    res, code = mark(marks_id, 3, "pick")
    check(res.status_code == code and res.json()["kind"] == "pick", "set pick")
    res, code = mark(marks_id, 1, "pick")
    check(res.status_code == code, "set second pick, marked later")
    d = marks_detail()
    check(d["picks"] == 2, "stats count every pick")
    check([im["id"] for im in d["cover"]] == [1, 3, 4]
          and d["best_image"]["id"] == 1,
          "cover fallback = latest pick; remaining picks lead the collage")
    check([o["image"]["mark"] for o in d["outputs"] if o["image"]["id"] in (1, 3)]
          == ["pick", "pick"], "detail outputs carry their mark")

    ok(c.patch(f"/api/series/{marks_id}", json={"coverImageId": 4}), "set coverImageId")
    d = marks_detail()
    check(d["cover_image_id"] == 4 and d["cover_image"]["id"] == 4
          and d["best_image"]["id"] == 4 and d["cover"][0]["id"] == 4,
          "explicit cover wins the three-way fallback")
    ok(c.patch(f"/api/series/{marks_id}", json={"bestImageId": 5}), "legacy bestImageId alias")
    d = marks_detail()
    check(d["cover_image_id"] == 5 and d["cover"][0]["id"] == 5,
          "legacy bestImageId still sets the explicit cover")

    ok(c.patch(f"/api/series/{marks_id}", json={"coverImageId": 4}), "cover before reject")
    res, code = mark(marks_id, 4, "reject")
    check(res.status_code == code, "replace a pick with reject")
    d = marks_detail()
    check(d["cover_image_id"] is None and d["best_image_id"] is None
          and d["best_image"]["id"] == 1,
          "rejecting the explicit cover clears it and falls back")
    check(all(im["id"] != 4 for im in d["cover"]), "rejected image is excluded from the collage")

    res, code = mark(marks_id, 1, None)
    check(res.status_code == code and res.json()["kind"] is None, "null clears a mark")
    check((1, "pick") not in mark_rows() and (3, "pick") in mark_rows(),
          "only the requested mark is cleared")

    ok(c.patch(f"/api/series/{marks_id}", json={"coverImageId": 3}), "set cover before clear picks")
    res = ok(c.post(f"/api/series/{marks_id}/marks/clear", json={"kind": "pick"}),
             "clear all picks")
    d = marks_detail()
    check(res["cleared"] == 1 and d["picks"] == 0 and (4, "reject") in mark_rows()
          and d["cover_image_id"] == 3,
          "clear picks keeps rejects and the explicit cover")

    # Version and attempts views expose marks, including the pick/reject filters.
    mark(marks_id, 1, "pick")
    mark(marks_id, 5, "reject")
    vv = c.get(f"/api/series/{marks_id}/versions?limit=100").json()["versions"]
    attempts = {a["id"]: a for v in vv for a in v["attempts"]}
    check(attempts[marked[0]]["mark"] == "pick"
          and attempts[marked[0]]["outputImage"]["mark"] == "pick"
          and attempts[marked[2]]["mark"] == "reject",
          "versions carry mark on each output")
    tl = c.get(f"/api/series/{marks_id}/generations?limit=100").json()["generations"]
    check({g["id"]: g["mark"] for g in tl}[marked[2]] == "reject"
          and {g["id"]: g["outputImage"]["mark"] for g in tl}[marked[0]] == "pick",
          "attempts timeline carries mark on each output")
    picked = c.get(f"/api/series/{marks_id}/versions?limit=100&status=pick").json()["versions"]
    visible = [a["id"] for v in picked for a in v["attempts"]]
    check(visible == [marked[0]] and any(v["hidden"] for v in picked),
          "versions status=pick filters by mark")
    rejected = c.get(f"/api/series/{marks_id}/versions?limit=100&status=reject").json()["versions"]
    check({a["id"] for v in rejected for a in v["attempts"]} == {marked[2], marked[3]},
          "versions status=reject filters by mark")

    tree = c.get("/api/series").json()
    theme_node = next(t for t in tree["themes"] if t["id"] == mark_theme)
    node = next(s for s in theme_node["series"] if s["id"] == marks_id)
    check(node["picks"] == 1 and theme_node["picks"] == 1,
          "tree and theme sum picks")
    check([im["id"] for im in node["cover"]] == [3, 1],
          "tree uses the same cover fallback and collage order")

    # Moving a record out drops a mark only when no other record in the old
    # series still outputs that image.
    other = ok(c.post("/api/series", json={"name": "Marks elsewhere"}),
               "create marks destination")["id"]
    ok(c.post(f"/api/series/{other}/assign", json={"generationIds": [marked[0]]}),
       "move the only output of image 1")
    check((1, "pick") not in mark_rows(), "moving out cleans an orphaned mark")

    mark(marks_id, 3, "pick")
    duplicate = ok(c.post("/api/generations/manual", json={
        "model": "gemini-3-pro-image", "status": "success", "prompt": "duplicate output",
        "createdAt": at(40), "outputImageId": 3, "seriesId": marks_id,
    }), "duplicate image output")["id"]
    ok(c.post(f"/api/series/{other}/assign", json={"generationIds": [marked[1]]}),
       "move one of two outputs of image 3")
    check((3, "pick") in mark_rows(), "mark survives while another output uses the image")
    ok(c.post(f"/api/series/{other}/assign", json={"generationIds": [duplicate]}),
       "move the last output of image 3")
    check((3, "pick") not in mark_rows(), "moving the last output cleans the mark")

    # Purging removes the mark and an explicit cover; an edit that changes an
    # output similarly cleans a mark that no longer belongs to the series.
    ok(c.post("/api/generations/manual", json={
        "model": "gemini-3-pro-image", "status": "success", "prompt": "fallback output",
        "createdAt": at(45), "outputImageId": 3, "seriesId": marks_id,
    }), "fallback output after cleanup")
    ok(c.patch(f"/api/series/{marks_id}", json={"coverImageId": 4}), "cover for purge")
    mark(marks_id, 4, "pick")
    with db.get_conn() as conn:
        from app.routes.images import _purge
        _purge(conn, dict(conn.execute("SELECT * FROM images WHERE id = 4").fetchone()))
    check((4, "pick") not in mark_rows(), "purge removes the image's marks")
    d = marks_detail()
    check(d["cover_image_id"] is None and d["best_image_id"] is None
          and d["best_image"] is not None,
          "purge clears an explicit cover and falls back")

    keep = ok(c.post("/api/generations/manual", json={
        "model": "gemini-3-pro-image", "status": "success", "prompt": "edit output",
        "createdAt": at(50), "outputImageId": 1, "seriesId": marks_id,
    }), "record for output edit")["id"]
    mark(marks_id, 1, "pick")
    ok(c.patch(f"/api/generations/{keep}", json={
        "model": "gemini-3-pro-image", "status": "error", "prompt": "edit output",
        "outputImageId": None, "seriesId": marks_id,
    }), "edit removes the output")
    check((1, "pick") not in mark_rows(), "changing an output cleans its orphaned mark")

    # One-time best -> pick migration; the marker keeps a new explicit cover
    # from being converted into a pick by a later restart.
    legacy = ok(c.post("/api/series", json={"name": "Legacy best"}), "legacy best series")["id"]
    with db.get_conn() as conn:
        conn.execute("UPDATE series SET best_image_id = 1 WHERE id = ?", (legacy,))
        conn.execute("DELETE FROM series_marks WHERE series_id = ?", (legacy,))
        conn.execute("DELETE FROM settings WHERE key = 'series_marks_best_migrated'")
    db.init_storage()
    with db.get_conn() as conn:
        migrated = [tuple(r) for r in conn.execute(
            "SELECT image_id, kind FROM series_marks WHERE series_id = ?", (legacy,)
        ).fetchall()]
        best = conn.execute("SELECT best_image_id FROM series WHERE id = ?", (legacy,)).fetchone()[0]
    check(migrated == [(1, "pick")] and best is None,
          "migration turns best_image_id into a pick and clears the explicit cover")
    db.init_storage()
    check(mark_rows(legacy) == [(1, "pick")], "best -> pick migration is idempotent")
    ok(c.patch(f"/api/series/{legacy}", json={"coverImageId": 5}), "explicit cover after migration")
    db.init_storage()
    with db.get_conn() as conn:
        best = conn.execute("SELECT best_image_id FROM series WHERE id = ?", (legacy,)).fetchone()[0]
    check(best == 5 and mark_rows(legacy) == [(1, "pick")],
          "a post-migration explicit cover is not converted again")

    ok(c.delete(f"/api/series/{lab}"), "delete order lab")
    with db.get_conn() as conn:
        check(conn.execute("SELECT COUNT(*) FROM generations WHERE id IN (?, ?) AND series_pos IS NOT NULL", (A, E)).fetchone()[0] == 0,
              "deleting a series clears series_pos")

print(f"\n{len(failures)} failure(s)" if failures else "\nall series checks passed")
print(f"data dir: {data_dir}")
sys.exit(1 if failures else 0)
