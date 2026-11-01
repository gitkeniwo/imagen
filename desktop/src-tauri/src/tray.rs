//! Menubar icon: the icon state machine, its right-click menu, the status
//! poller, and the small shared state the popover reads.
//!
//! The poller is one background thread: it asks the backend for
//! `/api/remote/status` and `/api/desktop/activity`, folds in the shell's own
//! view of the child process, applies the icon (only when it changed), and
//! pushes the result to the popover while it is open.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::backend;
use crate::{popover, quit};

pub const TRAY_ID: &str = "imagen";
pub const TRAY_OPEN_ID: &str = "tray-open";
pub const TRAY_REMOTE_ID: &str = "tray-remote";
pub const TRAY_QUIT_ID: &str = "tray-quit";

// The shell holds one long-poll request open; the backend answers as soon as a
// revision bumps. This fallback catches time-based transitions (a device going
// idle, a queue report aging out), network/firewall changes seen by the cached
// checks, and any lost wake-up.
const FALLBACK: Duration = Duration::from_secs(15);
const LONG_POLL_TIMEOUT_S: u64 = 25;
// Read timeout > hold time + status computation.
const LONG_POLL_READ: Duration = Duration::from_secs(35);
const SHELL_CHECK: Duration = Duration::from_millis(500);
const PULSE_EVERY: Duration = Duration::from_millis(700);
const TICK: Duration = Duration::from_millis(120);

const ICON_OFF: &[u8] = include_bytes!("../icons/tray/off.png");
const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray/active.png");
const ICON_GENERATING_B: &[u8] = include_bytes!("../icons/tray/generating-b.png");
const ICON_NO_CODE: &[u8] = include_bytes!("../icons/tray/no-code.png");
const ICON_BLOCKED: &[u8] = include_bytes!("../icons/tray/blocked.png");
const ICON_STOPPED: &[u8] = include_bytes!("../icons/tray/stopped.png");

/// Everything the popover page needs. Serialized as-is.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TrayState {
    /// Shell view: starting | healthy | stopped.
    pub backend: String,
    pub has_library: bool,
    /// Unix seconds when the backend was first seen stopped in this run.
    pub stopped_at: Option<u64>,
    /// GET /api/remote/status, or null while the backend is unreachable.
    pub status: Option<Value>,
    /// GET /api/desktop/activity.
    pub activity: Option<Value>,
    /// Backend generations + this Mac's pending queue items.
    pub generating: u64,
    pub lang: Option<String>,
    pub no_code_dismissed: bool,
    pub test_mode: bool,
}

impl TrayState {
    fn new(app: &AppHandle) -> Self {
        Self {
            backend: backend::shell_status(app).to_string(),
            has_library: backend::has_library(app),
            stopped_at: None,
            status: None,
            activity: None,
            generating: 0,
            lang: None,
            no_code_dismissed: false,
            test_mode: backend::test_mode(app),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IconState {
    Off,
    Idle,
    Active,
    NoCode,
    Blocked,
    Stopped,
    Generating,
}

impl IconState {
    fn bytes(self, pulse_frame: bool) -> &'static [u8] {
        match self {
            Self::Off => ICON_OFF,
            Self::Idle => ICON_IDLE,
            Self::Active => ICON_ACTIVE,
            Self::Generating if pulse_frame => ICON_GENERATING_B,
            Self::Generating => ICON_ACTIVE,
            Self::NoCode => ICON_NO_CODE,
            Self::Blocked => ICON_BLOCKED,
            Self::Stopped => ICON_STOPPED,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Idle => "idle",
            Self::Active => "active",
            Self::NoCode => "no-code",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Generating => "generating",
        }
    }
}

struct TrayInner {
    state: TrayState,
    last_remote_state: Option<String>,
    last_icon: Option<IconState>,
    pulse_frame: bool,
    /// (language, remote-access checked) the current tray menu was built for.
    menu_signature: Option<(String, bool)>,
}

pub struct TrayHandle {
    inner: Mutex<TrayInner>,
}

/// Set by the poller's callers (spawn / stop / restart / popover) to skip the
/// remaining sleep and refresh immediately.
static WAKE: AtomicBool = AtomicBool::new(false);
static LAST_LIBRARY_REQUEST: Mutex<Option<String>> = Mutex::new(None);

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(TrayHandle {
        inner: Mutex::new(TrayInner {
            state: TrayState::new(app),
            last_remote_state: None,
            last_icon: None,
            pulse_frame: false,
            menu_signature: Some((menu_lang(None).to_string(), false)),
        }),
    });

    let menu = build_menu(app, menu_lang(None), false)?;
    let icon = Image::from_bytes(ICON_OFF)?;
    let tooltip = if backend::test_mode(app) {
        "Imagen (test)"
    } else {
        "Imagen"
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                popover::toggle(tray.app_handle(), rect);
            }
        })
        .build(app)?;

    // The initial icon follows the real backend state as soon as it is known.
    spawn_poll(app.clone());
    Ok(())
}

/// Debug-only: open the popover under the real tray icon, for verified
/// screenshots without clicking the menu bar. Used by `IMAGEN_DEV_POPOVER`.
#[cfg(debug_assertions)]
pub fn debug_show_popover(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match tray.rect() {
            Ok(Some(rect)) => popover::show(app, rect),
            other => backend::log_line(app, &format!("dev popover: no tray rect ({other:?})")),
        }
    }
}

/// Remove the icon before the process goes away, so it cannot linger in the
/// menu bar of a dying process (also covers `app.exit`).
pub fn destroy(app: &AppHandle) {
    WAKE.store(false, Ordering::SeqCst);
    let _ = app.remove_tray_by_id(TRAY_ID);
}

pub fn state(app: &AppHandle) -> TrayState {
    match app.try_state::<TrayHandle>() {
        Some(handle) => handle
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .state
            .clone(),
        None => TrayState::default(),
    }
}

/// Backend generations plus the local queue. Used by the quit guard.
pub fn running_total(app: &AppHandle) -> u64 {
    state(app).generating
}

pub fn refresh_now(_app: &AppHandle) {
    WAKE.store(true, Ordering::SeqCst);
}

pub fn dismiss_no_code(app: &AppHandle) {
    if let Some(handle) = app.try_state::<TrayHandle>() {
        handle
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .state
            .no_code_dismissed = true;
    }
    push_to_popover(app);
}

/// Handles the tray menu items. Returns true when the event belonged to us.
pub fn handle_menu_event(app: &AppHandle, event: &tauri::menu::MenuEvent) -> bool {
    let id = event.id().as_ref();
    match id {
        TRAY_OPEN_ID => {
            crate::show_main(app);
            true
        }
        TRAY_REMOTE_ID => {
            let current = state(app)
                .status
                .as_ref()
                .and_then(|s| s.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let app = app.clone();
            thread::spawn(move || {
                let port = backend::port(&app);
                let body = json!({ "enabled": !current });
                if let Some((code, _)) =
                    backend::http_json(port, "PUT", "/api/remote/config", Some(&body))
                {
                    if code != 200 {
                        backend::log_line(&app, &format!("tray remote toggle failed: HTTP {code}"));
                    }
                }
                refresh_now(&app);
            });
            true
        }
        TRAY_QUIT_ID => {
            quit::request(app, false);
            true
        }
        _ => false,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn menu_lang(lang: Option<&str>) -> &'static str {
    // Same default as the app menu: Chinese until the frontend says otherwise.
    match lang {
        Some("en") => "en",
        _ => "zh",
    }
}

fn is_english(lang: &str) -> bool {
    lang == "en"
}

fn build_menu(app: &AppHandle, lang: &str, checked: bool) -> tauri::Result<Menu<Wry>> {
    let en = is_english(lang);
    let open = MenuItem::with_id(
        app,
        TRAY_OPEN_ID,
        if en { "Open Imagen" } else { "打开 Imagen" },
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let remote = CheckMenuItem::with_id(
        app,
        TRAY_REMOTE_ID,
        if en { "Remote access" } else { "远程访问" },
        true,
        checked,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        TRAY_QUIT_ID,
        if en { "Quit Imagen" } else { "退出 Imagen" },
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    Menu::with_items(
        app,
        &[
            &open,
            &remote,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn apply_icon(app: &AppHandle, icon: IconState, pulse_frame: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let Ok(image) = Image::from_bytes(icon.bytes(pulse_frame)) else {
        return;
    };
    if let Err(err) = tray.set_icon(Some(image)) {
        backend::log_line(app, &format!("tray set_icon failed: {err}"));
    }
    // set_icon resets the template flag; a template keeps the glyph black and
    // lets macOS invert it for dark/highlighted menu bars.
    let _ = tray.set_icon_as_template(true);
}

fn apply_menu(app: &AppHandle, lang: &str, checked: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app, lang, checked) {
        Ok(menu) => {
            if let Err(err) = tray.set_menu(Some(menu)) {
                backend::log_line(app, &format!("tray set_menu failed: {err}"));
            }
        }
        Err(err) => backend::log_line(app, &format!("tray menu build failed: {err}")),
    }
}

fn push_to_popover(app: &AppHandle) {
    if !popover::is_visible(app) {
        return;
    }
    let snapshot = state(app);
    if let Err(err) = app.emit_to("menubar", "menubar://state", snapshot) {
        backend::log_line(app, &format!("menubar state emit failed: {err}"));
    }
}

fn activity_number(activity: &Option<Value>, key: &str) -> u64 {
    activity
        .as_ref()
        .and_then(|a| a.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn exiting(app: &AppHandle) -> bool {
    app.try_state::<backend::BackendState>()
        .map(|s| s.exiting.load(Ordering::SeqCst))
        .unwrap_or(true)
}

fn snapshot_status(body: &Value) -> (Option<Value>, Option<Value>) {
    (body.get("status").cloned(), body.get("activity").cloned())
}

fn handle_library_request(app: &AppHandle, body: &Value) {
    let Some(request) = body.get("library_request").and_then(Value::as_object) else {
        return;
    };
    let Some(id) = request.get("id").and_then(Value::as_str) else {
        return;
    };
    {
        let mut last = LAST_LIBRARY_REQUEST
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if last.as_deref() == Some(id) {
            return;
        }
        *last = Some(id.to_string());
    }
    let port = backend::port(app);
    let path = format!("/api/desktop/library-request/{id}/ack");
    match backend::http_json(port, "POST", &path, None) {
        Some((200, _)) => {}
        Some((code, _)) => {
            clear_library_request_retry(id);
            backend::log_line(app, &format!("remote library request ack failed: HTTP {code}"));
            return;
        }
        None => {
            clear_library_request_retry(id);
            backend::log_line(app, "remote library request ack failed: backend unreachable");
            return;
        }
    }
    let Some(index) = request
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
    else {
        backend::log_line(app, "remote library request rejected: invalid index");
        return;
    };
    let Some(path) = request.get("path").and_then(Value::as_str) else {
        backend::log_line(app, "remote library request rejected: missing path");
        return;
    };
    let by = request
        .get("by")
        .and_then(Value::as_str)
        .unwrap_or("Remote device");
    crate::library::open_remote_request(app, index, path.to_string(), by.to_string());
}

fn clear_library_request_retry(id: &str) {
    let mut last = LAST_LIBRARY_REQUEST
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if last.as_deref() == Some(id) {
        *last = None;
    }
}

/// Apply the shell's own state and, when given, a fresh remote snapshot.
///
/// `None` is the cheap 500 ms tick: it only refreshes the child-process state
/// (stopped/starting/healthy), so a backend crash changes the icon at once.
/// A snapshot arrives on every long-poll response and fallback poll.
fn commit(app: &AppHandle, snapshot: Option<(Option<Value>, Option<Value>)>) {
    let backend_state = backend::shell_status(app).to_string();
    let has_library = backend::has_library(app);
    let test_mode = backend::test_mode(app);

    let Some(handle) = app.try_state::<TrayHandle>() else {
        return;
    };
    let mut inner = handle.inner.lock().unwrap_or_else(|p| p.into_inner());

    let mut shell_changed = inner.state.backend != backend_state
        || inner.state.has_library != has_library
        || inner.state.test_mode != test_mode;
    let has_snapshot = snapshot.is_some();

    if let Some((status, activity)) = snapshot {
        inner.state.status = status;
        inner.state.activity = activity;
    }

    // Derived from the snapshot (recomputed every commit so shell-only ticks
    // keep them). Entering no_code (including at launch) un-dismisses the note.
    let remote_state = inner
        .state
        .status
        .as_ref()
        .and_then(|s| s.get("state"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if remote_state.as_deref() == Some("no_code")
        && inner.last_remote_state.as_deref() != Some("no_code")
    {
        inner.state.no_code_dismissed = false;
    }
    if remote_state.is_some() {
        inner.last_remote_state = remote_state;
    }
    inner.state.generating = activity_number(&inner.state.activity, "generating")
        + activity_number(&inner.state.activity, "queued_local");
    inner.state.lang = inner
        .state
        .activity
        .as_ref()
        .and_then(|a| a.get("lang"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let stopped_at = if backend_state == "stopped" {
        match (inner.state.backend.as_str(), inner.state.stopped_at) {
            ("stopped", Some(at)) => Some(at),
            _ => Some(now_secs()),
        }
    } else {
        None
    };
    if inner.state.stopped_at != stopped_at {
        shell_changed = true;
    }
    inner.state.backend = backend_state.clone();
    inner.state.has_library = has_library;
    inner.state.test_mode = test_mode;
    inner.state.stopped_at = stopped_at;

    // Pick the icon. When the backend is up but a status request failed, keep
    // the last icon instead of guessing.
    let desired = if !has_library {
        Some(IconState::Off)
    } else if backend_state != "healthy" {
        Some(IconState::Stopped)
    } else {
        match inner
            .state
            .status
            .as_ref()
            .and_then(|s| s.get("state"))
            .and_then(Value::as_str)
        {
            Some("blocked") => Some(IconState::Blocked),
            Some("no_code") => Some(IconState::NoCode),
            _ if inner.state.generating > 0 => Some(IconState::Generating),
            Some("active") => Some(IconState::Active),
            Some("idle") => Some(IconState::Idle),
            Some("off") => Some(IconState::Off),
            _ => None,
        }
    };
    let mut change_icon = None;
    if let Some(icon) = desired {
        if inner.last_icon != Some(icon) {
            inner.last_icon = Some(icon);
            if icon == IconState::Generating {
                inner.pulse_frame = false;
            }
            change_icon = Some(icon);
        }
    }

    let current_lang = menu_lang(inner.state.lang.as_deref());
    let checked = inner
        .state
        .status
        .as_ref()
        .and_then(|s| s.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut change_menu = None;
    let signature = (current_lang.to_string(), checked);
    if inner.menu_signature.as_ref() != Some(&signature) {
        inner.menu_signature = Some(signature);
        change_menu = Some((current_lang, checked));
    }
    let push = has_snapshot || shell_changed;
    drop(inner);

    if let Some(icon) = change_icon {
        backend::log_line(app, &format!("tray icon -> {}", icon.name()));
        apply_icon(app, icon, false);
    }
    if let Some((lang, checked)) = change_menu {
        apply_menu(app, lang, checked);
    }
    if push {
        push_to_popover(app);
    }
}

/// Hold `/api/desktop/wait` open forever. The backend answers when a revision
/// bumps (config change, listener state, sessions, generation counts, client
/// queue), so idle cost is one blocked request instead of a poll every second.
fn spawn_long_poll(app: AppHandle) {
    thread::spawn(move || {
        let mut revision: u64 = 0;
        loop {
            if exiting(&app) || app.try_state::<TrayHandle>().is_none() {
                break;
            }
            let port = backend::port(&app);
            let path = format!(
                "/api/desktop/wait?since={revision}&timeout={LONG_POLL_TIMEOUT_S}"
            );
            match backend::http_json_timeout(port, "GET", &path, None, LONG_POLL_READ) {
                Some((200, body)) => {
                    revision = body.get("revision").and_then(Value::as_u64).unwrap_or(0);
                    handle_library_request(&app, &body);
                    let (status, activity) = snapshot_status(&body);
                    commit(&app, Some((status, activity)));
                }
                _ => {
                    // Backend down/restarting: retry slowly and let the shell
                    // tick thread show the stopped icon.
                    for _ in 0..10 {
                        if exiting(&app) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
    });
}

fn spawn_poll(app: AppHandle) {
    spawn_long_poll(app.clone());
    thread::spawn(move || {
        let mut next_shell = Instant::now();
        let mut next_fallback = Instant::now() + FALLBACK;
        let mut next_pulse = Instant::now();
        let mut pulsing = false;
        loop {
            if exiting(&app) || app.try_state::<TrayHandle>().is_none() {
                break;
            }

            let now = Instant::now();
            // refresh_now() covers spawn/stop/restart and explicit "check now".
            let wake = WAKE.swap(false, Ordering::SeqCst);
            if wake || now >= next_shell {
                commit(&app, None);
                next_shell = Instant::now() + SHELL_CHECK;
            }
            if wake || now >= next_fallback {
                // since=0 always returns immediately; this also re-runs the
                // cached network/firewall checks when their TTL expired.
                let port = backend::port(&app);
                if let Some((200, body)) = backend::http_json(
                    port,
                    "GET",
                    "/api/desktop/wait?since=0&timeout=0",
                    None,
                ) {
                    handle_library_request(&app, &body);
                    let (status, activity) = snapshot_status(&body);
                    commit(&app, Some((status, activity)));
                }
                next_fallback = Instant::now() + FALLBACK;
            }

            // Pulse two frames while a generation is in flight. Only the
            // generating icon animates; every other state is static.
            let (generating, frame) = match app.try_state::<TrayHandle>() {
                Some(handle) => {
                    let inner = handle.inner.lock().unwrap_or_else(|p| p.into_inner());
                    (
                        inner.last_icon == Some(IconState::Generating),
                        inner.pulse_frame,
                    )
                }
                None => break,
            };
            if generating {
                if !pulsing {
                    pulsing = true;
                    next_pulse = Instant::now() + PULSE_EVERY;
                } else if Instant::now() >= next_pulse {
                    let next = !frame;
                    if let Some(handle) = app.try_state::<TrayHandle>() {
                        handle
                            .inner
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .pulse_frame = next;
                    }
                    apply_icon(&app, IconState::Generating, next);
                    next_pulse = Instant::now() + PULSE_EVERY;
                }
            } else {
                pulsing = false;
            }

            thread::sleep(TICK);
        }
    });
}
