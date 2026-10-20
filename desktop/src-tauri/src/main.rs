// Prevent a console window on Windows in release builds (kept for parity even
// though this batch only targets macOS).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod download;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    backend::restart_backend(&app)
}

fn main() {
    // A set IMAGEN_DATA_DIR means a test/dev instance: no single-instance lock
    // and no window-state plugin (that plugin would write into the real
    // ~/Library/Application Support/com.gitkeniwo.imagen directory).
    let test_mode = std::env::var("IMAGEN_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    let mut builder = tauri::Builder::default();

    // Tauri requires the single-instance plugin to be registered first.
    if !test_mode {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _argv, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ));
    }

    builder = builder.plugin(tauri_plugin_dialog::init());
    if !test_mode {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    let app = builder
        // Keep the default macOS menu: it is what provides ⌘C/⌘V/⌘A/⌘Z and
        // the Edit menu inside WKWebView.
        .menu(tauri::menu::Menu::default)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![restart_backend])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = backend::BackendState::new(&handle)?;
            let port = state.config.port;
            app.manage(state);

            backend::log_line(
                &handle,
                &format!("shell starting test_mode={test_mode} port={port}"),
            );

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Imagen")
            .inner_size(1400.0, 900.0)
            .min_inner_size(960.0, 640.0)
            .disable_drag_drop_handler()
            .on_navigation(move |url| backend::navigation_allowed(url, port))
            .on_download(download::handle)
            .build()?;

            if let Err(e) = backend::spawn(&handle) {
                backend::show_error(&handle, &e);
            } else {
                let wait_handle = handle.clone();
                std::thread::spawn(move || backend::wait_until_healthy(wait_handle));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Imagen app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            backend::shutdown(app_handle);
        }
    });
}
