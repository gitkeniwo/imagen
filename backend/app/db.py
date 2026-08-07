"""SQLite connection and schema initialization."""
import contextlib
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
    marker_color    TEXT
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
    updated_at                  TEXT NOT NULL
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
"""


# Created after _migrate so index columns exist on pre-migration databases.
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_image_tags_tag_id ON image_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_generations_output_image_id ON generations(output_image_id);
CREATE INDEX IF NOT EXISTS idx_generation_inputs_image_id ON generation_inputs(image_id);
CREATE INDEX IF NOT EXISTS idx_images_deleted_at ON images(deleted_at);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_client_task_id
    ON generations(client_task_id) WHERE client_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_order ON drafts(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_images_image_id ON draft_images(image_id);
CREATE INDEX IF NOT EXISTS idx_draft_tags_tag_id ON draft_tags(tag_id);
"""


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
