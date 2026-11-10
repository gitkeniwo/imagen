"""SQLite connection and schema initialization."""
import contextlib
import hashlib
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# data/ lives at backend/data; override with IMAGEN_DATA_DIR for isolated runs
# (e.g. tests/verification) so real data is never touched.
DATA_DIR = Path(
    os.environ.get("IMAGEN_DATA_DIR")
    or (Path(__file__).resolve().parent.parent / "data")
)
IMAGES_DIR = DATA_DIR / "images"
THUMBS_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "app.db"


def library_key() -> str:
    """Opaque, cache-safe identity for the currently open library."""
    return hashlib.sha256(str(DATA_DIR.resolve()).encode("utf-8")).hexdigest()[:16]

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256      TEXT UNIQUE,
    filename    TEXT,
    mime        TEXT,
    width       INTEGER,
    height      INTEGER,
    byte_size   INTEGER,
    source      TEXT,                 -- 'upload' | 'generated'
    file_path   TEXT,
    thumb_path  TEXT,
    starred     INTEGER DEFAULT 0,
    note        TEXT,                 -- user note/label for a saved (starred) prompt
    created_at  TEXT,
    deleted_at  TEXT                  -- NULL = live; set = in recycle bin
);

CREATE TABLE IF NOT EXISTS generations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt          TEXT,
    model           TEXT,
    aspect_ratio    TEXT,
    resolution      TEXT,
    status          TEXT,             -- 'running' | 'success' | 'blocked' | 'error' | 'note'
    error_message   TEXT,
    raw_finish      TEXT,
    output_image_id INTEGER REFERENCES images(id),
    created_at      TEXT,
    source          TEXT NOT NULL DEFAULT 'vertex', -- 'vertex' (real call) | 'manual' (logged)
    client_task_id  TEXT,
    marker_color    TEXT,
    provider        TEXT NOT NULL DEFAULT 'vertex', -- 'vertex' | 'gemini'
    duration_ms     INTEGER,          -- provider call time, NULL for legacy/manual
    attempts        INTEGER            -- actual provider requests, NULL for legacy/manual
);

CREATE TABLE IF NOT EXISTS generation_inputs (
    generation_id INTEGER REFERENCES generations(id) ON DELETE CASCADE,
    image_id      INTEGER REFERENCES images(id),
    position      INTEGER,
    PRIMARY KEY (generation_id, image_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT UNIQUE,
    color           TEXT,
    cover_image_id  INTEGER REFERENCES images(id) ON DELETE SET NULL,
    created_at      TEXT
);

-- many-to-many: an image may belong to several tags (union, idempotent)
CREATE TABLE IF NOT EXISTS image_tags (
    image_id   INTEGER REFERENCES images(id) ON DELETE CASCADE,
    tag_id     INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT,
    PRIMARY KEY (image_id, tag_id)
);

CREATE TABLE IF NOT EXISTS drafts (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt                      TEXT NOT NULL DEFAULT '',
    model                       TEXT NOT NULL,
    aspect_ratio                TEXT,
    resolution                  TEXT,
    output_format               TEXT NOT NULL DEFAULT 'image/jpeg',
    skip_if_preceding_succeeds  INTEGER NOT NULL DEFAULT 0,
    pinned                      INTEGER NOT NULL DEFAULT 0,
    legacy_generation_id        INTEGER UNIQUE REFERENCES generations(id),
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    provider                    TEXT NOT NULL DEFAULT 'vertex'
);

CREATE TABLE IF NOT EXISTS draft_images (
    draft_id  INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
    image_id  INTEGER REFERENCES images(id) ON DELETE CASCADE,
    role      TEXT NOT NULL CHECK (role IN ('input', 'output')),
    position  INTEGER NOT NULL,
    PRIMARY KEY (draft_id, role, image_id)
);

CREATE TABLE IF NOT EXISTS draft_tags (
    draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
    tag_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (draft_id, tag_id)
);

-- Two-level grouping of one line of work: a 'theme' groups 'series' rows,
-- and generations/drafts point at a series (generations.series_id). Deleting
-- a theme moves its series to "No theme"; deleting a series only clears the
-- reference on its records. Kind rules are enforced by the triggers below.
CREATE TABLE IF NOT EXISTS series (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL CHECK (kind IN ('theme', 'series')),
    parent_id      INTEGER REFERENCES series(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    color          TEXT,
    best_image_id  INTEGER REFERENCES images(id) ON DELETE SET NULL,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
"""


# Fixed-width UTC ISO-8601 (``2026-11-05T18:18:23.603635+00:00``): text order
# equals time order, which History's ``ORDER BY created_at`` relies on.
_CANONICAL_TS_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]+00:00"

# History's sort key. Canonical timestamps sort as themselves; anything else
# (unparsable text the migration had to keep, or NULL) becomes '' and sorts
# after every real time. A plain `created_at DESC` would put "not-a-date"
# first, since letters compare greater than digits. Every History query uses
# this exact text so SQLite can match it to idx_generations_sort.
GENERATION_SORT_AT = (
    f"(CASE WHEN created_at GLOB '{_CANONICAL_TS_GLOB}' THEN created_at ELSE '' END)"
)


# --- series order (series-v2 B2) ----------------------------------------------
# `generations.series_pos` is a record's place inside its series. It starts out
# in time order, then follows the user's custom order (drag / move). Gaps of
# SERIES_POS_STEP leave room to insert between two records at their midpoint.
SERIES_POS_STEP = 1024.0
# Below this distance between neighbors the series is renumbered n * STEP.
SERIES_POS_EPSILON = 1e-6


def _sort_at(alias: str) -> str:
    return GENERATION_SORT_AT.replace("created_at", f"{alias}.created_at")


def place_by_time_sql(target: str) -> str:
    """UPDATE that puts row ``target`` into its series in time order (§3 rule 1).

    It lands right after the furthest-placed record of the series that is
    older by ``(GENERATION_SORT_AT, id)``, at the midpoint to the next record
    (or one step past the last / before the first). Rows without a position
    are ignored, so a batch can be placed one row at a time. Shared by the
    triggers below and by the migration, so every writer — assign, import,
    manual create, record edit — follows the same rule.
    """
    me, p, n = "generations", "p", "n"
    older = (
        f"SELECT MAX({p}.series_pos) FROM generations {p} "
        f"WHERE {p}.series_id = {me}.series_id AND {p}.id != {me}.id "
        f"AND {p}.series_pos IS NOT NULL "
        f"AND ({_sort_at(p)} < {_sort_at(me)} "
        f"OR ({_sort_at(p)} = {_sort_at(me)} AND {p}.id < {me}.id))"
    )
    nxt = (
        f"SELECT MIN({n}.series_pos) FROM generations {n} "
        f"WHERE {n}.series_id = {me}.series_id AND {n}.id != {me}.id "
        f"AND {n}.series_pos > COALESCE(({older}), -1e300)"
    )
    step = SERIES_POS_STEP
    return (
        f"UPDATE generations SET series_pos = COALESCE("
        f"(({older}) + ({nxt})) / 2.0, ({older}) + {step}, ({nxt}) - {step}, {step}) "
        f"WHERE id = {target} AND series_id IS NOT NULL"
    )


# Placement and clearing live in triggers so that every path that writes
# series_id follows them, including routes that know nothing about order.
# /api/generate inserts with an explicit series_pos (max + STEP: new attempts
# always go last), which the insert trigger leaves alone. Renumbering when
# gaps get too small is done in Python (series_order.renumber_if_tight).
SERIES_POS_TRIGGERS = f"""
CREATE TRIGGER IF NOT EXISTS trg_generations_series_pos_insert
AFTER INSERT ON generations
WHEN NEW.series_id IS NOT NULL AND NEW.series_pos IS NULL
BEGIN {place_by_time_sql("NEW.id")}; END;
CREATE TRIGGER IF NOT EXISTS trg_generations_series_pos_update
AFTER UPDATE OF series_id ON generations
WHEN NEW.series_id IS NOT OLD.series_id
BEGIN
    UPDATE generations SET series_pos = NULL WHERE id = NEW.id;
    {place_by_time_sql("NEW.id")};
END;
"""


# Created after _migrate so index columns exist on pre-migration databases.
INDEXES = f"""
CREATE INDEX IF NOT EXISTS idx_image_tags_tag_id ON image_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_generations_output_image_id ON generations(output_image_id);
DROP INDEX IF EXISTS idx_generations_created_at;
CREATE INDEX IF NOT EXISTS idx_generations_sort
    ON generations({GENERATION_SORT_AT} DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_generation_inputs_image_id ON generation_inputs(image_id);
CREATE INDEX IF NOT EXISTS idx_images_deleted_at ON images(deleted_at);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_client_task_id
    ON generations(client_task_id) WHERE client_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_order ON drafts(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_images_image_id ON draft_images(image_id);
CREATE INDEX IF NOT EXISTS idx_draft_tags_tag_id ON draft_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_generations_series_id ON generations(series_id);
CREATE INDEX IF NOT EXISTS idx_drafts_series_id ON drafts(series_id);
CREATE INDEX IF NOT EXISTS idx_series_parent_id ON series(parent_id);
-- Names are unique per parent (case-insensitive). Themes and unthemed series
-- both have a NULL parent but live in separate namespaces, hence `kind`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_unique_name
    ON series(kind, COALESCE(parent_id, 0), name COLLATE NOCASE);

-- Two levels only: a theme has no parent; a series' parent is a theme.
CREATE TRIGGER IF NOT EXISTS trg_series_parent_insert
BEFORE INSERT ON series
WHEN NEW.parent_id IS NOT NULL AND (
    NEW.kind = 'theme'
    OR (SELECT kind FROM series WHERE id = NEW.parent_id) IS NOT 'theme')
BEGIN SELECT RAISE(ABORT, 'series parent must be a theme'); END;
CREATE TRIGGER IF NOT EXISTS trg_series_parent_update
BEFORE UPDATE OF parent_id, kind ON series
WHEN NEW.parent_id IS NOT NULL AND (
    NEW.kind = 'theme'
    OR (SELECT kind FROM series WHERE id = NEW.parent_id) IS NOT 'theme')
BEGIN SELECT RAISE(ABORT, 'series parent must be a theme'); END;
-- Records belong to a series (leaf), never to a theme.
CREATE TRIGGER IF NOT EXISTS trg_generations_series_insert
BEFORE INSERT ON generations
WHEN NEW.series_id IS NOT NULL
    AND (SELECT kind FROM series WHERE id = NEW.series_id) IS NOT 'series'
BEGIN SELECT RAISE(ABORT, 'series_id must point at a series'); END;
CREATE TRIGGER IF NOT EXISTS trg_generations_series_update
BEFORE UPDATE OF series_id ON generations
WHEN NEW.series_id IS NOT NULL
    AND (SELECT kind FROM series WHERE id = NEW.series_id) IS NOT 'series'
BEGIN SELECT RAISE(ABORT, 'series_id must point at a series'); END;
CREATE TRIGGER IF NOT EXISTS trg_drafts_series_insert
BEFORE INSERT ON drafts
WHEN NEW.series_id IS NOT NULL
    AND (SELECT kind FROM series WHERE id = NEW.series_id) IS NOT 'series'
BEGIN SELECT RAISE(ABORT, 'series_id must point at a series'); END;
CREATE TRIGGER IF NOT EXISTS trg_drafts_series_update
BEFORE UPDATE OF series_id ON drafts
WHEN NEW.series_id IS NOT NULL
    AND (SELECT kind FROM series WHERE id = NEW.series_id) IS NOT 'series'
BEGIN SELECT RAISE(ABORT, 'series_id must point at a series'); END;
CREATE INDEX IF NOT EXISTS idx_generations_series_pos ON generations(series_id, series_pos);
""" + SERIES_POS_TRIGGERS


def canonical_timestamp(value: str) -> str:
    """Normalize an ISO-8601 timestamp to canonical UTC text.

    Naive values are taken as UTC. Raises ValueError for unparsable input."""
    dt = datetime.fromisoformat(value.strip())
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


def now_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def init_storage() -> None:
    """Create data directories and the database schema if missing."""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        # WAL lets concurrent readers proceed while a generation commits.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.executescript(INDEXES)


def _migrate(conn) -> None:
    """Idempotent in-place migrations for pre-existing databases."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(images)")}
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE images ADD COLUMN deleted_at TEXT")
    if "note" not in cols:
        conn.execute("ALTER TABLE images ADD COLUMN note TEXT")

    gen_cols = {r["name"] for r in conn.execute("PRAGMA table_info(generations)")}
    if "source" not in gen_cols:
        conn.execute(
            "ALTER TABLE generations ADD COLUMN source TEXT NOT NULL DEFAULT 'vertex'"
        )
    if "client_task_id" not in gen_cols:
        conn.execute("ALTER TABLE generations ADD COLUMN client_task_id TEXT")
    if "marker_color" not in gen_cols:
        conn.execute("ALTER TABLE generations ADD COLUMN marker_color TEXT")
    # Rows from before multi-provider support were all Vertex calls.
    if "provider" not in gen_cols:
        conn.execute(
            "ALTER TABLE generations ADD COLUMN provider TEXT NOT NULL DEFAULT 'vertex'"
        )
    if "duration_ms" not in gen_cols:
        conn.execute("ALTER TABLE generations ADD COLUMN duration_ms INTEGER")
    if "attempts" not in gen_cols:
        conn.execute("ALTER TABLE generations ADD COLUMN attempts INTEGER")
    # Series membership (one series per record). Nullable with ON DELETE SET
    # NULL, so deleting a series never deletes history.
    if "series_id" not in gen_cols:
        conn.execute(
            "ALTER TABLE generations ADD COLUMN series_id INTEGER "
            "REFERENCES series(id) ON DELETE SET NULL"
        )
    # Custom order inside a series (series-v2 B2). The first run numbers each
    # series in time order (ROW_NUMBER * STEP); later runs only place rows
    # that somehow lack a position, so a custom order is never reset.
    if "series_pos" not in gen_cols:
        conn.execute("ALTER TABLE generations ADD COLUMN series_pos REAL")
    _backfill_series_pos(conn)
    draft_cols = {r["name"] for r in conn.execute("PRAGMA table_info(drafts)")}
    if "provider" not in draft_cols:
        conn.execute(
            "ALTER TABLE drafts ADD COLUMN provider TEXT NOT NULL DEFAULT 'vertex'"
        )
    if "series_id" not in draft_cols:
        conn.execute(
            "ALTER TABLE drafts ADD COLUMN series_id INTEGER "
            "REFERENCES series(id) ON DELETE SET NULL"
        )

    # History sorts by created_at as text. Older rows may lack microseconds
    # ("…:00+00:00"), use "Z", or carry a non-UTC offset from a manual entry;
    # rewrite those to the canonical form. Unparsable values are left alone.
    odd = conn.execute(
        "SELECT id, created_at FROM generations "
        "WHERE created_at IS NOT NULL AND created_at NOT GLOB ?",
        (_CANONICAL_TS_GLOB,),
    ).fetchall()
    for row in odd:
        try:
            fixed = canonical_timestamp(row["created_at"])
        except ValueError:
            continue
        if fixed != row["created_at"]:
            conn.execute(
                "UPDATE generations SET created_at = ? WHERE id = ?", (fixed, row["id"])
            )

    # A process restart necessarily interrupts every in-flight request. Keep
    # its prompt/history record, but do not leave a permanent "waiting" card.
    conn.execute(
        """UPDATE generations
           SET status = 'error',
               error_message = COALESCE(error_message, 'Generation interrupted before a response was stored.'),
               raw_finish = COALESCE(raw_finish, 'INTERRUPTED')
           WHERE status = 'running'"""
    )

    # Notes used to be represented as generation rows. Copy them into the
    # dedicated draft domain without deleting or modifying the originals. The
    # unique legacy_generation_id makes this migration safe to run repeatedly.
    notes = conn.execute(
        "SELECT * FROM generations WHERE status = 'note' ORDER BY id"
    ).fetchall()
    for note in notes:
        existing = conn.execute(
            "SELECT id FROM drafts WHERE legacy_generation_id = ?", (note["id"],)
        ).fetchone()
        if existing:
            continue
        now = note["created_at"] or datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            """INSERT INTO drafts
               (prompt, model, aspect_ratio, resolution, output_format,
                skip_if_preceding_succeeds, pinned, legacy_generation_id,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, 'image/jpeg', 0, 0, ?, ?, ?)""",
            (
                note["prompt"] or "",
                (
                    "gemini-3-pro-image"
                    if note["model"] == "gemini-3-pro-image-preview"
                    else note["model"] or "gemini-3-pro-image"
                ),
                note["aspect_ratio"],
                note["resolution"],
                note["id"],
                now,
                now,
            ),
        )
        draft_id = cur.lastrowid
        inputs = conn.execute(
            """SELECT image_id, position FROM generation_inputs
               WHERE generation_id = ? ORDER BY position""",
            (note["id"],),
        ).fetchall()
        for row in inputs:
            conn.execute(
                """INSERT OR IGNORE INTO draft_images
                   (draft_id, image_id, role, position) VALUES (?, ?, 'input', ?)""",
                (draft_id, row["image_id"], row["position"]),
            )
        if note["output_image_id"]:
            conn.execute(
                """INSERT OR IGNORE INTO draft_images
                   (draft_id, image_id, role, position) VALUES (?, ?, 'output', 0)""",
                (draft_id, note["output_image_id"]),
            )
    conn.commit()


def _backfill_series_pos(conn) -> None:
    """Give every series member a ``series_pos``; idempotent.

    A series where nobody has a position yet (fresh column) is numbered in
    time order. Stray rows in an already ordered series (written by an older
    build without the triggers) are placed by the time rule, oldest first.
    """
    missing = conn.execute(
        f"""SELECT id, series_id FROM generations
            WHERE series_id IS NOT NULL AND series_pos IS NULL
            ORDER BY series_id, {GENERATION_SORT_AT} ASC, id ASC"""
    ).fetchall()
    if not missing:
        return
    ordered = {
        r["series_id"]
        for r in conn.execute(
            "SELECT DISTINCT series_id FROM generations "
            "WHERE series_id IS NOT NULL AND series_pos IS NOT NULL"
        ).fetchall()
    }
    fresh = [r for r in missing if r["series_id"] not in ordered]
    rank: dict[int, int] = {}
    updates = []
    for r in fresh:
        rank[r["series_id"]] = rank.get(r["series_id"], 0) + 1
        updates.append((rank[r["series_id"]] * SERIES_POS_STEP, r["id"]))
    conn.executemany("UPDATE generations SET series_pos = ? WHERE id = ?", updates)
    for r in missing:
        if r["series_id"] in ordered:
            conn.execute(place_by_time_sql("?"), (r["id"],))


@contextlib.contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Connection with row access by name and FK enforcement.

    Commits on clean exit, rolls back on error, and always closes — the bare
    sqlite3 context manager never closes, which leaks file descriptors on a
    long-running server.
    """
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
