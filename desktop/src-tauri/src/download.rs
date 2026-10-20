//! Save WKWebView downloads into ~/Downloads without ever overwriting a file.

use std::path::{Path, PathBuf};

use tauri::webview::DownloadEvent;
use tauri::{Manager, Webview, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

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
                .or_else(|| {
                    url.path_segments()
                        .and_then(|mut segs| segs.next_back())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "download".to_string());

            let name = safe_file_name(&suggested);
            let target = unique_path(&dir, &name);
            backend::log_line(
                app,
                &format!("download requested {url} -> {}", target.display()),
            );
            *destination = target;
            true
        }
        DownloadEvent::Finished { url, success, .. } => {
            let app = webview.app_handle();
            if success {
                backend::log_line(app, &format!("download finished {url}"));
            } else {
                backend::log_line(app, &format!("download FAILED {url}"));
                app.dialog()
                    .message(format!("下载失败：{url}"))
                    .title("Imagen")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
            true
        }
        _ => true,
    }
}
