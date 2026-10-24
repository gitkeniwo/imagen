//! ⌘Q guard: quitting while generations run requires holding ⌘Q for ~0.9 s.
//!
//! Mouse-driven quits (app menu item, tray menu item) never wait, exactly like
//! Chrome's tab-close guard. The HUD window is `desktop/splash/quit-hud.html`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::tray;

pub const QUIT_MENU_ID: &str = "quit";

/// Pull fallback for the HUD page (called when it becomes visible).
#[tauri::command]
pub fn quit_hud_state() -> Option<serde_json::Value> {
    HUD_PAYLOAD
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}
pub const HUD_LABEL: &str = "quit-hud";
const HUD_WIDTH: f64 = 300.0;
const HUD_HEIGHT: f64 = 64.0;
const HOLD: Duration = Duration::from_millis(900);
const LINGER: Duration = Duration::from_millis(1500);
const FADE_OUT: Duration = Duration::from_millis(220);

/// True while the HUD is up (also suppresses key-repeat re-entry).
static HUD_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Last HUD text. The page reads it when it becomes visible, so a dropped
/// event can never leave an empty (but blurred) HUD on screen.
static HUD_PAYLOAD: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// Create the HUD hidden; `request` only positions, fills and shows it.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        HUD_LABEL,
        tauri::WebviewUrl::App("quit-hud.html".into()),
    )
    .title("Imagen")
    .inner_size(HUD_WIDTH, HUD_HEIGHT)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .closable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .shadow(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .on_navigation(|url| {
        url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.path() == "/quit-hud.html"
    })
    .build()?;

    let _ = window.set_ignore_cursor_events(true);

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(err) = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        ) {
            crate::backend::log_line(app, &format!("quit-hud vibrancy failed: {err}"));
        }
    }
    Ok(())
}

/// Handle a quit request. `via_keyboard` is true for ⌘Q only.
pub fn request(app: &AppHandle, via_keyboard: bool) {
    let running = tray::running_total(app);
    if !via_keyboard || running == 0 {
        app.exit(0);
        return;
    }
    if HUD_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    if !show_hud(app, running) {
        HUD_ACTIVE.store(false, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    thread::spawn(move || hold_guard(app));
}

fn show_hud(app: &AppHandle, running: u64) -> bool {
    let Some(window) = app.get_webview_window(HUD_LABEL) else {
        return false;
    };
    position_hud(app, &window);
    let lang = tray::state(app).lang.unwrap_or_else(|| "zh".to_string());
    let (title, sub) = if lang == "en" {
        (
            "Hold ⌘Q to quit".to_string(),
            if running == 1 {
                "1 generation still running".to_string()
            } else {
                format!("{running} generations still running")
            },
        )
    } else {
        (
            "按住 ⌘Q 退出".to_string(),
            if running == 1 {
                "还有 1 个生成在运行".to_string()
            } else {
                format!("还有 {running} 个生成在运行")
            },
        )
    };
    let payload = json!({ "title": title, "sub": sub });
    if let Ok(mut slot) = HUD_PAYLOAD.lock() {
        *slot = Some(payload.clone());
    }
    // Show first: a webview that was created hidden only reliably runs its
    // script once the window is ordered in.
    let _ = window.show();
    let _ = app.emit_to(HUD_LABEL, "quit-hud://show", payload);
    true
}

/// Debug-only: show the HUD for a few seconds (`IMAGEN_DEV_HUD=1`).
#[cfg(debug_assertions)]
pub fn debug_show_hud(app: &AppHandle) {
    if HUD_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    if !show_hud(app, 2) {
        HUD_ACTIVE.store(false, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(4));
        hide_hud(&app);
    });
}

fn hide_hud(app: &AppHandle) {
    if let Ok(mut slot) = HUD_PAYLOAD.lock() {
        *slot = None;
    }
    let _ = app.emit_to(HUD_LABEL, "quit-hud://hide", ());
    thread::sleep(FADE_OUT);
    if let Some(window) = app.get_webview_window(HUD_LABEL) {
        let _ = window.hide();
    }
    HUD_ACTIVE.store(false, Ordering::SeqCst);
}

fn hold_guard(app: AppHandle) {
    let start = Instant::now();
    // macOS delivers the menu key equivalent on key-down; poll the hardware
    // state until either ⌘ or Q is released or the hold time is reached.
    while chord_held() {
        if start.elapsed() >= HOLD {
            if let Some(window) = app.get_webview_window(HUD_LABEL) {
                let _ = window.hide();
            }
            app.exit(0);
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    thread::sleep(LINGER);
    hide_hud(&app);
}

fn position_hud(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .get_webview_window("main")
        .filter(|w| w.is_visible().unwrap_or(false))
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| {
            app.cursor_position()
                .ok()
                .and_then(|p| crate::monitor_at(app, p.x, p.y))
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let origin = monitor.position();
    let x = origin.x as f64 + (size.width as f64 - HUD_WIDTH * scale) / 2.0;
    let y = origin.y as f64 + size.height as f64 * 0.40;
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// Whether the event that triggered the menu action was a key press. A mouse
/// click on the menu item is not a keyboard quit and must not be guarded.
#[cfg(target_os = "macos")]
pub fn menu_event_is_keyboard() -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventType};

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let app = NSApplication::sharedApplication(mtm);
    match app.currentEvent() {
        Some(event) => event.r#type().0 == NSEventType::KeyDown.0,
        None => false,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn menu_event_is_keyboard() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn chord_held() -> bool {
    use std::os::raw::c_int;

    const COMBINED: c_int = 0;
    const KVK_ANSI_Q: u16 = 0x0C;
    const CMD_MASK: u64 = 1 << 20; // kCGEventFlagMaskCommand

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: c_int, key: u16) -> bool;
        fn CGEventSourceFlagsState(state: c_int) -> u64;
    }

    // Reading key/modifier state needs no accessibility prompt for the user's
    // own session; verify manually after changes to this function.
    unsafe { CGEventSourceKeyState(COMBINED, KVK_ANSI_Q) && CGEventSourceFlagsState(COMBINED) & CMD_MASK != 0 }
}

#[cfg(not(target_os = "macos"))]
fn chord_held() -> bool {
    false
}
