//! `ui.json`: shell-side UI state kept next to `desktop.json` (which stays
//! library-only). Several keys share the file — `zoom` (see `zoom.rs`) and
//! `recent_libraries` (see `library.rs`) — so every write is a
//! read-modify-write of the whole object that preserves keys it doesn't own.
//!
//! Data-directory test mode has no config path and therefore no `ui.json`.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::backend::BackendState;

pub const UI_FILE: &str = "ui.json";
pub const UI_VERSION: u64 = 1;

/// `ui.json` beside the desktop config, or `None` in data-dir test mode.
pub fn ui_path(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<BackendState>();
    let config = state.config.read().unwrap_or_else(|p| p.into_inner());
    config
        .config_path
        .as_ref()
        .and_then(|path| path.parent())
        .map(|dir| dir.join(UI_FILE))
}

/// `remote.json` (LAN remote-access settings, owned by the backend) beside
/// the desktop config, or `None` in data-dir test mode.
pub fn remote_path(app: &AppHandle) -> Option<PathBuf> {
    ui_path(app)
        .and_then(|ui| ui.parent().map(|dir| dir.join("remote.json")))
}

/// `secrets.json` (Gemini API key, owned by the backend, mode 0600) beside the
/// desktop config, or `None` in data-dir test mode.
pub fn secrets_path(app: &AppHandle) -> Option<PathBuf> {
    ui_path(app)
        .and_then(|ui| ui.parent().map(|dir| dir.join("secrets.json")))
}

/// The stored object when the file exists, parses, and has our version.
pub fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let data = fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&data).ok()?;
    if value.get("version").and_then(Value::as_u64) != Some(UI_VERSION) {
        return None;
    }
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Apply `change` to the current object (or a fresh one when the file is
/// missing/corrupt) and replace the file atomically: sibling temp file,
/// fsync, rename — mirroring `library::write_config`.
pub fn update(path: &Path, change: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let mut map = read_object(path).unwrap_or_default();
    map.insert("version".to_string(), Value::from(UI_VERSION));
    change(&mut map);

    let parent = path
        .parent()
        .ok_or_else(|| "ui.json has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create config directory {}: {e}", parent.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or(UI_FILE),
        std::process::id(),
        stamp
    ));
    let bytes = serde_json::to_vec(&Value::Object(map))
        .map_err(|e| format!("cannot serialize ui.json: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut file =
            File::create(&tmp).map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
        file.write_all(&bytes)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("cannot sync {}: {e}", tmp.display()))?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
