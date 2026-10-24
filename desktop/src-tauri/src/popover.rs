//! Menubar popover: a pre-created, hidden, transparent window positioned under
//! the tray icon, plus the commands its page calls.
//!
//! The page itself is `desktop/splash/menubar.html`, served from `frontendDist`
//! (`../splash`) — so it still renders when the Python backend is down.

use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Rect, Size,
};

use crate::backend;
use crate::tray;

pub const LABEL: &str = "menubar";
const WIDTH: f64 = 372.0;
const DEFAULT_HEIGHT: f64 = 600.0;
const GAP: f64 = 5.0;
/// A tray click that lands right after the popover closed itself (focus loss)
/// means "close", not "reopen".
const REOPEN_GRACE: Duration = Duration::from_millis(250);

static LAST_HIDDEN: Mutex<Option<Instant>> = Mutex::new(None);

/// Create the window hidden so opening it never flashes an empty frame.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("menubar.html".into()),
    )
    .title("Imagen")
    .inner_size(WIDTH, DEFAULT_HEIGHT)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .closable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .shadow(true)
    .visible(false)
    .focused(false)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    // This page never navigates: only its own asset URL is allowed.
    .on_navigation(|url| {
        url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.path() == "/menubar.html"
    })
    .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(err) = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        ) {
            backend::log_line(app, &format!("menubar vibrancy failed: {err}"));
        }
    }
    Ok(())
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.hide();
    backend::log_line(app, "menubar hide");
    if let Ok(mut guard) = LAST_HIDDEN.lock() {
        *guard = Some(Instant::now());
    }
}

pub fn toggle(app: &AppHandle, rect: Rect) {
    backend::log_line(app, &format!("tray click rect {rect:?}"));
    if is_visible(app) {
        hide(app);
        return;
    }
    if let Ok(guard) = LAST_HIDDEN.lock() {
        if guard
            .as_ref()
            .map(|at| at.elapsed() < REOPEN_GRACE)
            .unwrap_or(false)
        {
            return;
        }
    }
    show(app, rect);
}

fn physical_rect(rect: &Rect, scale: f64) -> (PhysicalPosition<i32>, Size) {
    let position = match &rect.position {
        Position::Physical(pos) => *pos,
        Position::Logical(pos) => pos.to_physical(scale),
    };
    (position, rect.size)
}

fn scale_for(app: &AppHandle, rect: &Rect) -> f64 {
    let monitor = match &rect.position {
        Position::Physical(pos) => crate::monitor_at(app, pos.x as f64, pos.y as f64),
        Position::Logical(_) => app.primary_monitor().ok().flatten(),
    };
    monitor.map(|m| m.scale_factor()).unwrap_or(1.0)
}

pub fn show(app: &AppHandle, rect: Rect) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let scale = scale_for(app, &rect);
    let (icon_pos, icon_size) = physical_rect(&rect, scale);
    let icon_h = match icon_size {
        Size::Physical(size) => size.height as f64,
        Size::Logical(size) => size.height * scale,
    };
    // The page reports its own content height; use whatever it last set.
    let win_size = window
        .inner_size()
        .unwrap_or(tauri::PhysicalSize::new(
            (WIDTH * scale).round() as u32,
            (DEFAULT_HEIGHT * scale).round() as u32,
        ));
    let mut x = icon_pos.x as f64;
    let mut y = icon_pos.y as f64 + icon_h + GAP * scale;
    if let Some(monitor) = crate::monitor_at(app, icon_pos.x as f64, icon_pos.y as f64) {
        let area = monitor.work_area();
        let left = area.position.x as f64;
        let top = area.position.y as f64;
        let right = left + area.size.width as f64;
        let bottom = top + area.size.height as f64;
        if x + win_size.width as f64 > right {
            x = right - win_size.width as f64;
        }
        if x < left {
            x = left;
        }
        if y + win_size.height as f64 > bottom {
            y = bottom - win_size.height as f64;
        }
        if y < top {
            y = top;
        }
    }
    backend::log_line(
        app,
        &format!(
            "menubar show at ({}, {}) {}x{}",
            x.round() as i32,
            y.round() as i32,
            win_size.width,
            win_size.height
        ),
    );
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.show();
    let _ = window.set_focus();
    // No NSPanel here: a plain borderless window only receives keyboard input
    // while its app is active, so opening the popover activates Imagen. Focus
    // moves back to the previous app when the popover closes.
    #[cfg(target_os = "macos")]
    crate::activate_app();
    let _ = app.emit_to(LABEL, "menubar://state", tray::state(app));
    tray::refresh_now(app);
}

// --- commands (menubar page only) -----------------------------------------

#[tauri::command]
pub fn menubar_state(app: AppHandle) -> tray::TrayState {
    tray::state(&app)
}

#[tauri::command]
pub fn menubar_resize(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let height = height.clamp(120.0, 1400.0);
    backend::log_line(&app, &format!("menubar resize to {height}"));
    let _ = window.set_size(LogicalSize::new(WIDTH, height));
}

#[tauri::command]
pub fn menubar_close(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn menubar_open_main(app: AppHandle) {
    crate::show_main(&app);
}

#[tauri::command]
pub fn menubar_open_settings(app: AppHandle) {
    crate::show_main(&app);
    let port = backend::port(&app);
    if let Some(window) = app.get_webview_window("main") {
        // Only the app page listens for this; the startup and error pages would
        // ignore it, and the popover already brought them forward.
        let on_app = window
            .url()
            .map(|url| {
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == Some(port)
            })
            .unwrap_or(false);
        if on_app {
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('imagen:open-settings',{detail:'remote'}))",
            );
        }
    }
}

#[tauri::command]
pub fn menubar_set_remote(app: AppHandle, enabled: bool) {
    thread::spawn(move || {
        let port = backend::port(&app);
        let body = json!({ "enabled": enabled });
        if let Some((code, _)) = backend::http_json(port, "PUT", "/api/remote/config", Some(&body))
        {
            if code != 200 {
                backend::log_line(&app, &format!("remote enable toggle failed: HTTP {code}"));
            }
        }
        tray::refresh_now(&app);
    });
}

#[tauri::command]
pub fn menubar_require_code(app: AppHandle) {
    thread::spawn(move || {
        let port = backend::port(&app);
        let body = json!({ "require_code": true });
        if let Some((code, _)) = backend::http_json(port, "PUT", "/api/remote/config", Some(&body))
        {
            if code != 200 {
                backend::log_line(&app, &format!("require_code failed: HTTP {code}"));
            }
        }
        tray::refresh_now(&app);
    });
}

#[tauri::command]
pub fn menubar_copy(app: AppHandle, what: String) -> Result<(), String> {
    let state = tray::state(&app);
    let status = state
        .status
        .as_ref()
        .ok_or_else(|| "No remote status".to_string())?;
    let port = status.get("port").and_then(Value::as_u64).unwrap_or(0);
    let text = match what.as_str() {
        "address" => {
            let list = status
                .get("addresses")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let pick = |kind: &str| {
                list.iter().find(|a| {
                    a.get("kind").and_then(Value::as_str) == Some(kind)
                })
            };
            let addr = pick("wifi")
                .or_else(|| pick("ethernet"))
                .or_else(|| pick("tailscale"))
                .or_else(|| list.first());
            let ip = addr
                .and_then(|a| a.get("ip"))
                .and_then(Value::as_str)
                .ok_or_else(|| "No local address".to_string())?;
            format!("http://{ip}:{port}")
        }
        "local" => {
            let name = status
                .get("local_name")
                .and_then(Value::as_str)
                .ok_or_else(|| "No local name".to_string())?;
            format!("http://{name}:{port}")
        }
        "code" => status
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| "No access code".to_string())?
            .to_string(),
        _ => return Err("Unknown copy target".to_string()),
    };
    copy_to_clipboard(&text);
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_to_clipboard(text: &str) {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let value = NSString::from_str(text);
    // The pasteboard type is an extern static (valid for the process lifetime).
    let pasteboard_type = unsafe { NSPasteboardTypeString };
    let _ = pasteboard.setString_forType(&value, pasteboard_type);
}

#[cfg(not(target_os = "macos"))]
fn copy_to_clipboard(_text: &str) {}

#[tauri::command]
pub fn menubar_dismiss_no_code(app: AppHandle) {
    tray::dismiss_no_code(&app);
}

#[tauri::command]
pub fn menubar_restart_backend(app: AppHandle) {
    thread::spawn(move || {
        if let Err(err) = backend::restart_backend(&app) {
            backend::log_line(&app, &format!("menubar restart failed: {err}"));
        }
        tray::refresh_now(&app);
    });
}

#[tauri::command]
pub fn menubar_show_logs(app: AppHandle) {
    thread::spawn(move || {
        let dir = backend::log_dir(&app);
        match Command::new("open").arg(&dir).status() {
            Ok(status) if status.success() => {}
            Ok(status) => backend::log_line(&app, &format!("open logs failed: {status}")),
            Err(err) => backend::log_line(&app, &format!("open logs failed: {err}")),
        }
    });
}

#[tauri::command]
pub fn menubar_open_firewall(app: AppHandle) {
    thread::spawn(move || {
        // macOS 15 lives in System Settings; keep older pane ids as fallbacks.
        const TARGETS: [&str; 3] = [
            "x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall",
            "x-apple.systempreferences:com.apple.Network-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.security?Firewall",
        ];
        for target in TARGETS {
            if Command::new("open")
                .arg(target)
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
            {
                return;
            }
        }
        backend::log_line(&app, "could not open the firewall settings pane");
    });
}

#[tauri::command]
pub fn menubar_recheck(app: AppHandle) {
    tray::refresh_now(&app);
}

#[tauri::command]
pub fn menubar_quit(app: AppHandle) {
    crate::quit::request(&app, true);
}
