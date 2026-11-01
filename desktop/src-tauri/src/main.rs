// Prevent a console window on Windows in release builds (kept for parity even
// though this batch only targets macOS).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod download;
mod library;
mod popover;
mod quit;
mod tray;
mod ui_store;
mod zoom;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, RunEvent, Theme, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

/// Bring Imagen to the front, as a regular app again. Every entry point shares
/// this: ⌘D, the popover, the tray menu, Reopen, single-instance, and the
/// "Remote access settings…" action.
pub fn show_main(app: &AppHandle) {
    // From Accessory the Dock icon and the app menu come back first; then the
    // window is shown and focused. set_focus alone sometimes leaves the app
    // inactive, so NSApplication::activate is called afterwards.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    #[cfg(target_os = "macos")]
    activate_app();
    popover::hide(app);
}

/// Monitor containing a point in *physical* pixels (the space tray rects and
/// cursor positions use). `AppHandle::monitor_from_point` takes logical points,
/// so it is not used here.
pub fn monitor_at(app: &AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        x >= pos.x as f64
            && x < pos.x as f64 + size.width as f64
            && y >= pos.y as f64
            && y < pos.y as f64 + size.height as f64
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).activate();
    }
}

/// The title bar is transparent, so it shows the window's background color.
/// Match the frontend's page background (`--main-bg`) so the title row and
/// the page read as one surface.
fn title_bar_color(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(2, 6, 23, 255),
        _ => Color(255, 255, 255, 255),
    }
}

#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    backend::restart_backend(&app)
}

#[tauri::command]
fn choose_library(app: AppHandle, mode: String) -> Result<(), String> {
    library::choose_library(app, mode)
}

#[tauri::command]
fn retry_library(app: AppHandle) -> Result<(), String> {
    library::retry_library(app)
}

#[tauri::command]
fn reveal_config(app: AppHandle) -> Result<(), String> {
    library::reveal_config(app)
}

#[tauri::command]
fn list_recent_libraries(app: AppHandle) -> Vec<serde_json::Value> {
    library::list_recent(app)
}

#[tauri::command]
fn open_recent_library(app: AppHandle, index: usize) -> Result<(), String> {
    library::open_recent(app, index)
}

#[tauri::command]
fn open_library_path(app: AppHandle, path: String) -> Result<(), String> {
    library::open_library_path(app, path)
}

#[tauri::command]
fn return_to_current(app: AppHandle) -> Result<(), String> {
    library::return_to_current(app)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let change = MenuItem::with_id(
        app,
        library::CHANGE_LIBRARY_MENU_ID,
        "更改图库位置…",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;

    // Filled from ui.json once the backend state exists (library::refresh_recent_menu).
    let recent = Submenu::with_id(app, library::RECENT_MENU_ID, "打开最近的图库", false)?;

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &change,
            &recent,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Not PredefinedMenuItem::quit: that terminates directly and would
            // skip the hold-to-quit guard.
            &MenuItem::with_id(
                app,
                quit::QUIT_MENU_ID,
                "退出 Imagen",
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let actual_size = MenuItem::with_id(
        app,
        zoom::ZOOM_RESET_MENU_ID,
        "实际大小",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        zoom::ZOOM_IN_MENU_ID,
        "放大",
        true,
        Some("CmdOrCtrl+="),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        zoom::ZOOM_OUT_MENU_ID,
        "缩小",
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &actual_size,
            &zoom_in,
            &zoom_out,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[])?;
    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

fn main() {
    // Any explicit test location means a test instance: no single-instance
    // lock and no window-state plugin (that plugin would write into the real
    // Application Support directory).
    let env_data = std::env::var("IMAGEN_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let env_config = std::env::var("IMAGEN_CONFIG_PATH")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let test_mode = env_data || env_config;

    let mut builder = tauri::Builder::default();

    // Tauri requires the single-instance plugin to be registered first.
    if !test_mode {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _argv, _cwd| show_main(app),
        ));
    }

    builder = builder.plugin(tauri_plugin_dialog::init());
    if !test_mode {
        // Never restore visibility: quitting from background mode (main window
        // hidden) must not make the next launch start with no window. The
        // menubar/HUD windows are created once and positioned by the shell, so
        // they are kept out of the state file entirely.
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&[popover::LABEL, quit::HUD_LABEL])
                .build(),
        );
    }

    let app = builder
        // Keep a standard macOS menu: Edit provides ⌘C/⌘V/⌘A/⌘Z inside
        // WKWebView, and Imagen adds the library-location command.
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if tray::handle_menu_event(app, &event) {
                return;
            }
            if event.id() == quit::QUIT_MENU_ID {
                quit::request(app, quit::menu_event_is_keyboard());
                return;
            }
            if !zoom::handle_menu_event(app, &event) {
                library::handle_menu_event(app, event);
            }
        })
        .on_window_event(|window, event| match event {
            // Closing the main window goes to the background: the WebView and
            // the local queue keep running, the Dock icon goes away.
            WindowEvent::CloseRequested { api, .. } => {
                match window.label() {
                    "main" => {
                        api.prevent_close();
                        let _ = window.hide();
                        popover::hide(window.app_handle());
                        #[cfg(target_os = "macos")]
                        let _ = window
                            .app_handle()
                            .set_activation_policy(ActivationPolicy::Accessory);
                    }
                    // The aux windows are created once and reused; a stray ⌘W
                    // must hide them, never destroy them.
                    "menubar" => {
                        api.prevent_close();
                        popover::hide(window.app_handle());
                    }
                    "quit-hud" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
            }
            WindowEvent::Focused(false) => {
                if window.label() == popover::LABEL {
                    popover::hide(window.app_handle());
                }
            }
            WindowEvent::ThemeChanged(theme) if window.label() == "main" => {
                let _ = window.set_background_color(Some(title_bar_color(*theme)));
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            choose_library,
            retry_library,
            reveal_config,
            return_to_current,
            list_recent_libraries,
            open_recent_library,
            open_library_path,
            popover::menubar_state,
            popover::menubar_resize,
            popover::menubar_close,
            popover::menubar_open_main,
            popover::menubar_open_settings,
            popover::menubar_set_remote,
            popover::menubar_require_code,
            popover::menubar_copy,
            popover::menubar_dismiss_no_code,
            popover::menubar_restart_backend,
            popover::menubar_show_logs,
            popover::menubar_open_firewall,
            popover::menubar_recheck,
            popover::menubar_quit,
            quit::quit_hud_state
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = backend::BackendState::new(&handle)?;
            let (port, has_library, test_mode) = {
                let config = state
                    .config
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                (config.port, config.library.is_some(), config.test_mode)
            };
            let problem = state.startup_problem.clone();
            let notice = state.startup_notice.clone();
            app.manage(state);
            app.manage(zoom::ZoomState::init(&handle));
            library::refresh_recent_menu(&handle);

            backend::log_line(
                &handle,
                &format!(
                    "shell starting test_mode={test_mode} port={port} library={}",
                    if has_library { "configured" } else { "unset" }
                ),
            );

            let initial = if has_library {
                "index.html"
            } else {
                "library.html"
            };
            let nav_handle = handle.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(initial.into()))
                .title("Imagen")
                .inner_size(1400.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    if url.scheme() == library::ACTION_SCHEME {
                        library::handle_action_url(&nav_handle, url);
                        return false;
                    }
                    backend::navigation_allowed(url, port)
                })
                .on_download(download::handle)
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        zoom::on_page_load(window.app_handle(), payload.url());
                        library::on_page_load(window.app_handle(), payload.url());
                    }
                })
                .title_bar_style(TitleBarStyle::Transparent)
                .hidden_title(true)
                // A hidden window must keep timers (queue processor, progress
                // polling) running, otherwise background mode would stall.
                .background_throttling(
                    tauri::utils::config::BackgroundThrottlingPolicy::Disabled,
                )
                .build()?;
            let theme = window.theme().unwrap_or(Theme::Light);
            let _ = window.set_background_color(Some(title_bar_color(theme)));

            zoom::install_plus_alias(&handle);

            // Menubar popover and quit HUD are created hidden, so opening them
            // is just show + focus (no white flash).
            if let Err(err) = popover::create(&handle) {
                backend::log_line(&handle, &format!("menubar window failed: {err}"));
            }
            if let Err(err) = quit::create(&handle) {
                backend::log_line(&handle, &format!("quit-hud window failed: {err}"));
            }
            if let Err(err) = tray::init(&handle) {
                backend::log_line(&handle, &format!("tray icon failed: {err}"));
            }

            // Debug-only hooks for verifying the popover/HUD without clicking
            // the menu bar (the plan's manual checks).
            #[cfg(debug_assertions)]
            {
                let dev = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if std::env::var("IMAGEN_DEV_POPOVER").ok().as_deref() == Some("1") {
                        tray::debug_show_popover(&dev);
                    }
                    if std::env::var("IMAGEN_DEV_HUD").ok().as_deref() == Some("1") {
                        quit::debug_show_hud(&dev);
                    }
                });
            }

            if has_library {
                if let Err(e) = backend::spawn(&handle) {
                    backend::show_error(&handle, &e);
                } else {
                    let wait_handle = handle.clone();
                    std::thread::spawn(move || backend::wait_until_healthy(wait_handle));
                }
            } else if let Some(problem) = problem {
                library::show_problem(&handle, &problem.path, &problem.reason);
            } else if let Some(notice) = notice {
                library::show_notice(&handle, &notice);
            } else if let Some(mode) = library::auto_pick_action() {
                library::navigate_auto_pick(&handle, mode);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Imagen app");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            // Remove the icon before the process dies, so nothing lingers in
            // the menu bar while the backend shuts down.
            tray::destroy(app_handle);
            backend::shutdown(app_handle);
        }
        RunEvent::Reopen { .. } => show_main(app_handle),
        _ => {}
    });
}
