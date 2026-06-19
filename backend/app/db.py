"""SQLite connection and schema initialization."""
import os
import sqlite3
from pathlib import Path

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
    created_at  TEXT,
    deleted_at  TEXT                  -- NULL = live; set = in recycle bin
);

CREATE TABLE IF NOT EXISTS generations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt          TEXT,
    model           TEXT,
    aspect_ratio    TEXT,
    resolution      TEXT,
    status          TEXT,             -- 'success' | 'blocked' | 'error'
    error_message   TEXT,
    raw_finish      TEXT,
    output_image_id INTEGER REFERENCES images(id),
    created_at      TEXT
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
"""


def init_storage() -> None:
    """Create data directories and the database schema if missing."""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn) -> None:
    """Idempotent in-place migrations for pre-existing databases."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(images)")}
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE images ADD COLUMN deleted_at TEXT")
    conn.commit()


def get_conn() -> sqlite3.Connection:
    """Open a connection with row access by name and FK enforcement."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn
