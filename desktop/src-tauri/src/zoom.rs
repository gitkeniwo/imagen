//! Page zoom for the main webview.
//!
//! WKWebView's `pageZoom` is not guaranteed to survive a navigation, so every
//! finished page load reapplies the level kept in `ZoomState`. Commands run
//! entirely in Rust through `WebviewWindow::set_zoom`; no front-end JavaScript
//! and no `zoomHotkeysEnabled` polyfill is involved.
//!
//! Levels live in `ui.json` next to the desktop config file. Data-directory
//! test mode keeps the level in memory only and never writes a file.

#[cfg(debug_assertions)]
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(debug_assertions)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Manager, Url};

use crate::backend::{self, BackendState};

pub const ZOOM_RESET_MENU_ID: &str = "zoom-actual-size";
pub const ZOOM_IN_MENU_ID: &str = "zoom-in";
pub const ZOOM_OUT_MENU_ID: &str = "zoom-out";

pub const DEFAULT_ZOOM: f64 = 1.0;

/// Close to the Safari/Chrome steps, including both 0.9 and 1.1 around 100%.
pub const ZOOM_LEVELS: [f64; 13] = [
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

const UI_FILE: &str = "ui.json";
const UI_VERSION: u64 = 1;
/// Delay between injected test actions. Long enough for the page to settle and
/// report a fresh `innerWidth`.
#[cfg(debug_assertions)]
const DEV_STEP_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoomAction {
    Reset,
    In,
    Out,
}

impl ZoomAction {
    #[cfg(debug_assertions)]
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "reset" | "actual" => Some(Self::Reset),
            "in" | "zoom-in" => Some(Self::In),
            "out" | "zoom-out" => Some(Self::Out),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Reset => "reset",
            Self::In => "in",
            Self::Out => "out",
        }
    }
}

pub struct ZoomState {
    level: Mutex<f64>,
    /// `ui.json` when this instance may persist; `None` for data-dir test mode.
    ui_path: Option<PathBuf>,
    #[cfg(debug_assertions)]
    dev_sequence_started: AtomicBool,
}

impl ZoomState {
    /// Read the saved level and log the outcome. Missing/corrupt/invalid files
    /// fall back to 100% with a warning in the shell log (no dialog).
    pub fn init(app: &AppHandle) -> Self {
        let ui_path = {
            let state = app.state::<BackendState>();
            let config = state.config.read().unwrap_or_else(|p| p.into_inner());
            config
                .config_path
                .as_ref()
                .and_then(|path| path.parent())
                .map(|dir| dir.join(UI_FILE))
        };

        let (level, warning) = match ui_path.as_deref() {
            Some(path) => read_ui(path),
            None => (DEFAULT_ZOOM, None),
        };
        if let Some(warning) = warning {
            backend::log_line(app, &format!("zoom config warning: {warning}"));
        }
        match ui_path.as_deref() {
            Some(path) => backend::log_line(
                app,
                &format!("page zoom {level} loaded from {}", path.display()),
            ),
            None => backend::log_line(
                app,
                &format!("page zoom {level} (memory only: IMAGEN_DATA_DIR test mode)"),
            ),
        }

        Self {
            level: Mutex::new(level),
            ui_path,
            #[cfg(debug_assertions)]
            dev_sequence_started: AtomicBool::new(false),
        }
    }

    pub fn level(&self) -> f64 {
        *self.level.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_level(&self, level: f64) {
        *self.level.lock().unwrap_or_else(|p| p.into_inner()) = level;
    }
}

fn level_index(level: f64) -> Option<usize> {
    ZOOM_LEVELS
        .iter()
        .position(|candidate| (candidate - level).abs() < 1e-9)
}

fn adjacent(level: f64, delta: isize) -> f64 {
    let Some(index) = level_index(level) else {
        return DEFAULT_ZOOM;
    };
    let next = if delta < 0 {
        index.saturating_sub(1)
    } else {
        (index + 1).min(ZOOM_LEVELS.len() - 1)
    };
    ZOOM_LEVELS[next]
}

fn read_ui(path: &Path) -> (f64, Option<String>) {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (
                DEFAULT_ZOOM,
                Some(format!(
                    "{} does not exist; using {DEFAULT_ZOOM}",
                    path.display()
                )),
            )
        }
        Err(err) => {
            return (
                DEFAULT_ZOOM,
                Some(format!(
                    "cannot read {}: {err}; using {DEFAULT_ZOOM}",
                    path.display()
                )),
            )
        }
    };
    let value: Value = match serde_json::from_slice(&data) {
        Ok(value) => value,
        Err(err) => {
            return (
                DEFAULT_ZOOM,
                Some(format!(
                    "{} is not valid JSON ({err}); using {DEFAULT_ZOOM}",
                    path.display()
                )),
            )
        }
    };
    if value.get("version").and_then(Value::as_u64) != Some(UI_VERSION) {
        return (
            DEFAULT_ZOOM,
            Some(format!(
                "{} has an unsupported version; using {DEFAULT_ZOOM}",
                path.display()
            )),
        );
    }
    match value.get("zoom").and_then(Value::as_f64) {
        Some(zoom) if level_index(zoom).is_some() => (zoom, None),
        Some(zoom) => (
            DEFAULT_ZOOM,
            Some(format!(
                "{} has unsupported zoom {zoom}; using {DEFAULT_ZOOM}",
                path.display()
            )),
        ),
        None => (
            DEFAULT_ZOOM,
            Some(format!(
                "{} has no numeric zoom; using {DEFAULT_ZOOM}",
                path.display()
            )),
        ),
    }
}

/// Atomic replacement, mirroring `library::write_config`: sibling temp file,
/// fsync, then rename.
fn write_ui(path: &Path, level: f64) -> Result<(), String> {
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
    let bytes = serde_json::to_vec(&json!({
        "version": UI_VERSION,
        "zoom": level,
    }))
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

/// Apply the current level to the main webview.
pub fn apply(app: &AppHandle) {
    let level = app.state::<ZoomState>().level();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(err) = window.set_zoom(level) {
        backend::log_line(app, &format!("page zoom {level} failed: {err}"));
    }
}

fn persist(app: &AppHandle, level: f64) {
    let path = app.state::<ZoomState>().ui_path.clone();
    let Some(path) = path else {
        return;
    };
    if let Err(err) = write_ui(&path, level) {
        backend::log_line(app, &format!("zoom config write failed: {err}"));
    }
}

/// The single entry point shared by menu items, the hidden Shift+Plus alias,
/// and the debug test sequence.
pub fn perform(app: &AppHandle, action: ZoomAction) {
    let state = app.state::<ZoomState>();
    let current = state.level();
    let next = match action {
        ZoomAction::Reset => DEFAULT_ZOOM,
        ZoomAction::In => adjacent(current, 1),
        ZoomAction::Out => adjacent(current, -1),
    };
    if action != ZoomAction::Reset && (next - current).abs() < 1e-9 {
        backend::log_line(
            app,
            &format!("zoom {} ignored: already at {current}", action.label()),
        );
        return;
    }
    state.set_level(next);
    apply(app);
    persist(app, next);
    backend::log_line(app, &format!("zoom {} -> {next}", action.label()));
}

pub fn handle_menu_event(app: &AppHandle, event: &MenuEvent) -> bool {
    let action = match event.id().as_ref() {
        ZOOM_RESET_MENU_ID => ZoomAction::Reset,
        ZOOM_IN_MENU_ID => ZoomAction::In,
        ZOOM_OUT_MENU_ID => ZoomAction::Out,
        _ => return false,
    };
    perform(app, action);
    true
}

/// Called for every finished page load. Reapplying here covers splash → app,
/// backend restarts, and library changes.
pub fn on_page_load(app: &AppHandle, url: &Url) {
    apply(app);
    let level = app.state::<ZoomState>().level();
    backend::log_line(
        app,
        &format!("page load finished {url}; reapplied zoom {level}"),
    );
    maybe_start_dev_sequence(app, url);
}

#[cfg(debug_assertions)]
fn dev_sequence_env() -> Option<String> {
    env::var("IMAGEN_DEV_ZOOM_SEQUENCE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Debug-only: after the real app page loads, replay the same handlers the
/// menu uses. The environment variable is compiled out of release builds.
#[cfg(debug_assertions)]
fn maybe_start_dev_sequence(app: &AppHandle, url: &Url) {
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return;
    }
    let Some(sequence) = dev_sequence_env() else {
        return;
    };
    let state = app.state::<ZoomState>();
    if state.dev_sequence_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        backend::log_line(&handle, &format!("dev zoom sequence: {sequence}"));
        for raw in sequence.split(',') {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            std::thread::sleep(DEV_STEP_DELAY);
            match ZoomAction::parse(raw) {
                Some(action) => perform(&handle, action),
                None => backend::log_line(
                    &handle,
                    &format!("dev zoom sequence: unknown step {raw:?}"),
                ),
            }
        }
        backend::log_line(&handle, "dev zoom sequence: done");
    });
}

#[cfg(not(debug_assertions))]
fn maybe_start_dev_sequence(_app: &AppHandle, _url: &Url) {}

/// AppKit matches a key equivalent against the event's unmodified characters.
/// `CmdOrCtrl+=` (which muda maps to physical `Code::Equal`) therefore covers
/// ⌘=, while Shift+⌘= arrives as "+" and needs its own key equivalent. Tauri's
/// menu API only accepts physical `Code` names, so install one hidden native
/// alias whose target/action are the visible 放大 item: activating it emits the
/// same `zoom-in` menu event. `allowsKeyEquivalentWhenHidden` keeps it active
/// without adding a fourth row to the View menu.
#[cfg(target_os = "macos")]
pub fn install_plus_alias(app: &AppHandle) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSMenuItem, NSEventModifierFlags};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        backend::log_line(app, "zoom: plus alias not installed (not on main thread)");
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(main_menu) = ns_app.mainMenu() else {
        backend::log_line(app, "zoom: plus alias not installed (no main menu)");
        return;
    };
    let Some(view_item) = main_menu.itemWithTitle(&NSString::from_str("View")) else {
        backend::log_line(app, "zoom: plus alias not installed (View menu missing)");
        return;
    };
    let Some(view) = view_item.submenu() else {
        backend::log_line(app, "zoom: plus alias not installed (View submenu missing)");
        return;
    };

    let mut visible_index = None;
    let mut visible_item = None;
    for index in 0..view.numberOfItems() {
        let Some(item) = view.itemAtIndex(index) else {
            continue;
        };
        if item.title().to_string() == "放大" {
            visible_index = Some(index);
            visible_item = Some(item);
            break;
        }
    }
    let (Some(index), Some(item)) = (visible_index, visible_item) else {
        backend::log_line(app, "zoom: plus alias not installed (放大 item missing)");
        return;
    };

    let alias = unsafe {
        let alias = NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("放大"),
            item.action(),
            &NSString::from_str("+"),
        );
        // Dispatch through the visible muda item so the shell receives the
        // ordinary zoom-in menu event.
        alias.setTarget(Some(&item));
        alias
    };
    alias.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
    alias.setHidden(true);
    alias.setAllowsKeyEquivalentWhenHidden(true);
    view.insertItem_atIndex(&alias, index + 1);
    backend::log_line(app, "zoom: installed hidden Shift+Plus alias for 放大");
}

#[cfg(not(target_os = "macos"))]
pub fn install_plus_alias(_app: &AppHandle) {}
