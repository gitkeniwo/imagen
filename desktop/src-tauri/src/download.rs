//! Save WKWebView downloads into ~/Downloads without ever overwriting a file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::webview::DownloadEvent;
use tauri::{Manager, Webview, Wry};

use crate::backend;

fn fallback_downloads() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("Downloads"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn safe_file_name(name: &str) -> String {
    let base = Path::new(name.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if base.is_empty() || base == "." || base == ".." {
        "download".to_string()
    } else {
        base.to_string()
    }
}

/// `foo.png` -> `foo (1).png`, `foo (1).png`, ... until the path is free.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..10_000 {
        let candidate = match ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} (overflow)"))
}

/// macOS reports `Finished.path == None`, so remember the target chosen during
/// `Requested` and look it up by URL when the download completes.
fn pending() -> &'static Mutex<HashMap<String, PathBuf>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn name_from_url(url: &tauri::Url) -> String {
    url.path_segments()
        .and_then(|mut segs| segs.next_back())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "download".to_string())
}

fn notify_page(webview: &Webview<Wry>, ok: bool, name: &str) {
    let detail = serde_json::json!({ "ok": ok, "name": name });
    let detail = serde_json::to_string(&detail)
        .unwrap_or_else(|_| "{\"ok\":false,\"name\":\"download\"}".to_string());
    // JSON encoding above prevents a crafted filename from terminating the
    // string literal or injecting extra JavaScript.
    let script = format!(
        "window.dispatchEvent(new CustomEvent('imagen:download', {{ detail: {detail} }}));"
    );
    if let Err(e) = webview.eval(&script) {
        backend::log_line(webview.app_handle(), &format!("download event eval failed: {e}"));
    }
}

pub fn handle(webview: Webview<Wry>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let app = webview.app_handle();
            let dir = app.path().download_dir().unwrap_or_else(|_| fallback_downloads());
            if let Err(e) = std::fs::create_dir_all(&dir) {
                backend::log_line(app, &format!("cannot create download dir {dir:?}: {e}"));
            }

            let suggested = destination
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| name_from_url(&url));

            let name = safe_file_name(&suggested);
            let target = unique_path(&dir, &name);
            pending()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(url.as_str().to_string(), target.clone());
            backend::log_line(
                app,
                &format!("download requested {url} -> {}", target.display()),
            );
            *destination = target;
            true
        }
        DownloadEvent::Finished { url, success, .. } => {
            let app = webview.app_handle();
            let target = pending()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(url.as_str());
            let name = target
                .as_deref()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| name_from_url(&url));
            if success {
                backend::log_line(app, &format!("download finished {url} -> {name}"));
            } else {
                // Failure is reported by the in-app toast (dispatched below).
                backend::log_line(app, &format!("download FAILED {url} -> {name}"));
            }
            notify_page(&webview, success, &name);
            true
        }
        _ => true,
    }
}
