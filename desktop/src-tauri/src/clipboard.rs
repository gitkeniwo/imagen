//! Copy the original library file to the system clipboard.
//!
//! The page served by the Python backend is a *remote* Tauri origin, so IPC is
//! deliberately blocked there (see the app-page URL actions). It names
//! `imagen-action://copy-image/<id>` instead; the shell looks the row up over
//! loopback, reads the stored original (never the WebP thumbnail), and writes
//! its bytes to NSPasteboard under the file's real UTI. A JPEG therefore
//! stays a JPEG instead of being re-encoded by the browser.

use std::path::PathBuf;
use std::thread;

use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

use crate::backend::{self, BackendState};

pub const COPY_IMAGE_ACTION: &str = "copy-image";

/// `imagen-action://copy-image/<positive id>`, nothing else.
pub fn copy_image_id(url: &Url) -> Option<i64> {
    if url.scheme() != crate::library::ACTION_SCHEME
        || url.host_str() != Some(COPY_IMAGE_ACTION)
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let digits = url.path().strip_prefix('/')?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id: i64 = digits.parse().ok()?;
    (id > 0).then_some(id)
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// The pasteboard type must name the original encoding, not the decoded image.
fn uti_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("public.png"),
        "image/jpeg" | "image/jpg" => Some("public.jpeg"),
        "image/webp" => Some("org.webmproject.webp"),
        "image/gif" => Some("com.compuserve.gif"),
        _ => None,
    }
}

fn valid_sha(sha: &str) -> bool {
    sha.len() == 64
        && sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn lookup(port: u16, id: i64) -> Option<Value> {
    let (status, body) =
        backend::http_json(port, "GET", &format!("/api/images/lookup?ids={id}"), None)?;
    if status != 200 {
        return None;
    }
    body.get("images")?.as_array()?.first().cloned()
}

/// Read the stored original. Runs on the worker thread; the bytes are handed
/// to the main thread only for the pasteboard write.
fn read_original(app: &AppHandle, id: i64) -> Result<(Vec<u8>, &'static str), String> {
    let (port, library) = {
        let state = app.state::<BackendState>();
        let config = state.config.read().unwrap_or_else(|p| p.into_inner());
        (
            config.port,
            config.library.as_ref().map(|lib| lib.path.clone()),
        )
    };
    let library: PathBuf = library.ok_or_else(|| "尚未选择图库".to_string())?;

    let row = lookup(port, id).ok_or_else(|| "图片不存在".to_string())?;
    let sha = row
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "图片缺少哈希".to_string())?;
    let mime = row
        .get("mime")
        .and_then(Value::as_str)
        .ok_or_else(|| "图片缺少类型".to_string())?;
    if !valid_sha(sha) {
        return Err("图片哈希无效".to_string());
    }
    let ext = ext_for_mime(mime).ok_or_else(|| format!("不支持的图片类型 {mime}"))?;
    let uti = uti_for_mime(mime).ok_or_else(|| format!("不支持的图片类型 {mime}"))?;

    let path = library.join("images").join(format!("{sha}.{ext}"));
    let bytes = std::fs::read(&path).map_err(|err| format!("读取图片失败：{err}"))?;
    Ok((bytes, uti))
}

fn notify(app: &AppHandle, id: i64, ok: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let detail = serde_json::json!({ "id": id, "ok": ok }).to_string();
        let script = format!(
            "window.dispatchEvent(new CustomEvent('imagen:copy-image', {{ detail: {detail} }}));"
        );
        if let Err(err) = window.eval(&script) {
            backend::log_line(app, &format!("copy image event eval failed: {err}"));
        }
    }
}

/// Called from the `imagen-action://` navigation handler. Never blocks the UI
/// thread: the lookup and file read happen on a worker, the pasteboard write
/// on the main thread (AppKit), then the page gets its result event.
pub fn copy_image_from_action(app: &AppHandle, id: i64) {
    let app = app.clone();
    thread::spawn(move || match read_original(&app, id) {
        Ok((bytes, uti)) => {
            let handle = app.clone();
            let scheduled = app.run_on_main_thread(move || {
                let ok = write_image(&bytes, uti).is_ok();
                notify(&handle, id, ok);
            });
            if let Err(err) = scheduled {
                backend::log_line(&app, &format!("copy image {id} scheduling failed: {err}"));
            }
        }
        Err(err) => {
            backend::log_line(&app, &format!("copy image {id} failed: {err}"));
            notify(&app, id, false);
        }
    });
}

#[cfg(target_os = "macos")]
fn write_image(bytes: &[u8], uti: &str) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSData, NSString};

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let data = NSData::with_bytes(bytes);
    let pasteboard_type = NSString::from_str(uti);
    if pasteboard.setData_forType(Some(&data), &pasteboard_type) {
        Ok(())
    } else {
        Err("系统剪贴板拒绝了这张图片".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_image(_bytes: &[u8], _uti: &str) -> Result<(), String> {
    Err("复制图片只支持 macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<i64> {
        copy_image_id(&Url::parse(raw).unwrap())
    }

    #[test]
    fn accepts_only_an_id_path() {
        assert_eq!(parse("imagen-action://copy-image/42"), Some(42));
        assert_eq!(parse("imagen-action://copy-image/0"), None);
        assert_eq!(parse("imagen-action://copy-image/"), None);
        assert_eq!(parse("imagen-action://copy-image/4x"), None);
        assert_eq!(parse("imagen-action://copy-image/42?sha=x"), None);
        assert_eq!(parse("imagen-action://copy-image/42#x"), None);
        assert_eq!(parse("imagen-action://copy-image/42/1"), None);
        assert_eq!(parse("imagen-action://copy-image"), None);
        assert_eq!(parse("imagen-action://copy-image/9999999999"), None);
        assert_eq!(parse("imagen-action://open-library/42"), None);
        assert_eq!(parse("other://copy-image/42"), None);
    }

    #[test]
    fn maps_every_stored_type_to_its_original_encoding() {
        assert_eq!(ext_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(ext_for_mime("image/jpg"), Some("jpg"));
        assert_eq!(ext_for_mime("image/png"), Some("png"));
        assert_eq!(ext_for_mime("image/webp"), Some("webp"));
        assert_eq!(ext_for_mime("image/gif"), Some("gif"));
        assert_eq!(ext_for_mime("text/plain"), None);

        assert_eq!(uti_for_mime("image/jpeg"), Some("public.jpeg"));
        assert_eq!(uti_for_mime("image/webp"), Some("org.webmproject.webp"));
        assert_eq!(uti_for_mime("image/png"), Some("public.png"));
        assert_eq!(uti_for_mime("image/gif"), Some("com.compuserve.gif"));
        assert_eq!(uti_for_mime("text/plain"), None);
    }

    #[test]
    fn validates_sha256() {
        assert!(valid_sha(&"a".repeat(64)));
        assert!(valid_sha(&"0123456789abcdef".repeat(4)));
        assert!(!valid_sha(&"A".repeat(64)));
        assert!(!valid_sha(&"g".repeat(64)));
        assert!(!valid_sha(&"a".repeat(63)));
        assert!(!valid_sha(&"a".repeat(65)));
    }
}
