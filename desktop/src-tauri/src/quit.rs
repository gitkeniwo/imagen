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
/// Set by the local NSEvent monitor when Q or ⌘ is released. This is the
/// permission-free detector: CGEventSourceKeyState reads 0 without Input
/// Monitoring on recent macOS versions.
static HOLD_RELEASED: AtomicBool = AtomicBool::new(false);
/// Last HUD text. The page reads it when it becomes visible, so a dropped
/// event can never leave an empty (but blurred) HUD on screen.
static HUD_PAYLOAD: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// Watch key-up/flags changes for this app so a ⌘Q release is seen even though
/// the menu owns the key equivalent. The monitor returns the event unchanged,
/// so normal handling is untouched.
#[cfg(target_os = "macos")]
fn install_release_monitor() {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::ptr::NonNull;

    if RELEASE_MONITOR_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handler = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        let kind = event_ref.r#type().0;
        let released = (kind == NSEventType::KeyUp.0 && event_ref.keyCode() == 0x0C)
            || (kind == NSEventType::FlagsChanged.0
                && !event_ref
                    .modifierFlags()
                    .contains(NSEventModifierFlags::Command));
        if released {
            HOLD_RELEASED.store(true, Ordering::SeqCst);
        }
        event.as_ptr()
    });
    let mask = NSEventMask::KeyUp | NSEventMask::FlagsChanged;
    unsafe {
        if let Some(monitor) = NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler)
        {
            // AppKit retains the monitor and its block; leak our handles so the
            // monitor stays installed for the process lifetime.
            std::mem::forget(monitor);
            std::mem::forget(handler);
        }
    }
}

#[cfg(target_os = "macos")]
static RELEASE_MONITOR_INSTALLED: AtomicBool = AtomicBool::new(false);

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
    // Belt and braces: a restored/leftover window must never linger on screen.
    let _ = window.hide();
    #[cfg(target_os = "macos")]
    install_release_monitor();

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
        crate::backend::log_line(
            app,
            &format!("quit requested via_keyboard={via_keyboard} running={running}"),
        );
        app.exit(0);
        return;
    }
    // Key repeat re-enters this handler; only the first request of a hold counts.
    if HUD_ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    // Reset before showing the HUD, so an early key-up is not lost.
    HOLD_RELEASED.store(false, Ordering::SeqCst);
    crate::backend::log_line(
        app,
        &format!("quit requested via_keyboard={via_keyboard} running={running}"),
    );
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
    // The menu fires on key-down. If the hardware key-state API is readable it
    // is authoritative; otherwise the NSEvent monitor's release flag decides.
    let use_hardware_state = chord_held();
    loop {
        if HOLD_RELEASED.load(Ordering::SeqCst) {
            break;
        }
        if use_hardware_state && !chord_held() {
            break;
        }
        if start.elapsed() >= HOLD {
            crate::backend::log_line(
                &app,
                &format!(
                    "quit hold completed after {} ms (hardware_state={use_hardware_state})",
                    start.elapsed().as_millis()
                ),
            );
            if let Some(window) = app.get_webview_window(HUD_LABEL) {
                let _ = window.hide();
            }
            app.exit(0);
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    crate::backend::log_line(
        &app,
        &format!(
            "quit hold released after {} ms (hardware_state={use_hardware_state})",
            start.elapsed().as_millis()
        ),
    );
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
