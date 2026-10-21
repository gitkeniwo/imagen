//! Desktop library selection: config file, validation, picker flow, and pages.
//!
//! This module never touches the library until a selection has passed the Rust
//! checks. The backend repeats validation independently before importing
//! `app.db`, so a Rust bug cannot cause an empty library to be created.

use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::menu::{CheckMenuItem, MenuEvent};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::DialogExt;

use crate::backend::{self, BackendState};
use crate::ui_store;

pub const CHANGE_LIBRARY_MENU_ID: &str = "change-library";
/// App menu › 打开最近的图库; items are `open-recent-menu/<n>`, an index into
/// the shell's own recent list (same as `imagen-action://open-recent/<n>`).
pub const RECENT_MENU_ID: &str = "open-recent-menu";
pub const ACTION_SCHEME: &str = "imagen-action";
pub const CHANGE_LIBRARY_ACTION: &str = "change-library";
pub const REVEAL_LIBRARY_ACTION: &str = "reveal-library";
/// Settings › Library: native folder dialog first; the current backend keeps
/// running until a folder is actually picked.
pub const OPEN_LIBRARY_ACTION: &str = "open-library";
pub const CREATE_LIBRARY_ACTION: &str = "create-library";
/// `imagen-action://open-recent/<n>` — an index into the shell's own recent
/// list, never a path.
pub const OPEN_RECENT_ACTION: &str = "open-recent";
/// `imagen-action://open-path?p=<path>` — Settings' typed path. The one action
/// that carries a path: the shell validates it and asks the user to confirm in
/// a native dialog before anything changes.
pub const OPEN_PATH_ACTION: &str = "open-path";
const RECENT_KEY: &str = "recent_libraries";
const MAX_RECENT: usize = 8;
pub const CONFIG_VERSION: u64 = 1;
const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibraryMode {
    Existing,
    Create,
    Auto,
}

impl LibraryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Existing => "existing",
            Self::Create => "create",
            Self::Auto => "auto",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "existing" => Some(Self::Existing),
            "create" => Some(Self::Create),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct LibrarySelection {
    pub path: PathBuf,
    pub mode: LibraryMode,
}

#[derive(Clone, Debug)]
pub struct LibraryProblem {
    pub path: PathBuf,
    pub reason: String,
}

pub struct Startup {
    pub test_mode: bool,
    pub config_path: Option<PathBuf>,
    pub library: Option<LibrarySelection>,
    pub problem: Option<LibraryProblem>,
    pub notice: Option<String>,
    pub log_dir: PathBuf,
}

#[cfg(debug_assertions)]
fn nonempty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|e| format!("无法解析绝对路径：{e}"))
    }
}

fn default_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map(|home| home.join(".config/imagen/desktop.json"))
        .map_err(|e| format!("无法解析配置目录：{e}"))
}

fn read_config(path: &Path) -> Result<Option<PathBuf>, String> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("无法读取配置文件 {}：{err}", path.display())),
    };
    let value: serde_json::Value = serde_json::from_slice(&data)
        .map_err(|e| format!("配置文件不是有效 JSON：{e}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "配置缺少 version".to_string())?;
    if version != CONFIG_VERSION {
        return Err(format!(
            "配置版本不支持：{version}（期望 {CONFIG_VERSION}）"
        ));
    }
    let raw = value
        .get("library")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "配置缺少 library".to_string())?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("配置里的 library 必须是绝对路径".to_string());
    }
    Ok(Some(path))
}

/// Atomically replace the config file: write a sibling temp file, fsync, rename.
pub fn write_config(path: &Path, library: &Path) -> Result<(), String> {
    if !library.is_absolute() {
        return Err("图库路径必须是绝对路径".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件没有父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建配置目录 {}：{e}", parent.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("desktop.json"),
        std::process::id(),
        stamp
    ));
    let bytes = serde_json::to_vec_pretty(&json!({
        "version": CONFIG_VERSION,
        "library": library.to_string_lossy(),
    }))
    .map_err(|e| format!("无法序列化配置：{e}"))?;
    let result = (|| -> Result<(), String> {
        let mut file = File::create(&tmp)
            .map_err(|e| format!("无法创建临时配置 {}：{e}", tmp.display()))?;
        file.write_all(&bytes)
            .map_err(|e| format!("无法写入临时配置：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("无法同步临时配置：{e}"))?;
        drop(file);
        fs::rename(&tmp, path)
            .map_err(|e| format!("无法替换配置文件 {}：{e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn sqlite_header_ok(path: &Path) -> Result<(), String> {
    let mut file =
        File::open(path).map_err(|e| format!("无法读取 app.db {}：{e}", path.display()))?;
    let mut header = [0u8; 16];
    file.read_exact(&mut header)
        .map_err(|_| "app.db 小于 16 字节".to_string())?;
    if header != SQLITE_HEADER {
        return Err("app.db 的文件头不是 SQLite format 3".to_string());
    }
    Ok(())
}

pub fn validate_existing(path: &Path) -> Result<(), String> {
    let resolved = fs::canonicalize(path)
        .map_err(|_| format!("图库不可用：目录不存在：{}", path.display()))?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("图库不可用：{}：{e}", resolved.display()))?;
    if !metadata.is_dir() {
        return Err(format!("图库不可用：不是目录：{}", path.display()));
    }
    let db = resolved.join("app.db");
    let db_meta =
        fs::metadata(&db).map_err(|_| format!("图库不可用：缺少 app.db：{db:?}"))?;
    if !db_meta.is_file() {
        return Err(format!("图库不可用：app.db 不是普通文件：{db:?}"));
    }
    sqlite_header_ok(&db)
}

pub fn validate_create(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("新建图库路径必须是绝对路径".to_string());
    }
    if path.is_symlink() {
        return Err("新建图库不能使用软链接".to_string());
    }
    if path.exists() {
        if !path.is_dir() {
            return Err(format!("新建图库路径不是目录：{}", path.display()));
        }
        let mut entries = fs::read_dir(path)
            .map_err(|e| format!("无法读取目录 {}：{e}", path.display()))?;
        if entries.any(|entry| {
            entry
                .ok()
                .map(|e| e.file_name() != ".DS_Store" && e.file_name() != ".synthetic")
                .unwrap_or(true)
        }) {
            return Err("新建图库要求空目录（忽略 .DS_Store / .synthetic 测试标记）".to_string());
        }
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| "新建图库路径没有父目录".to_string())?;
        if !parent.is_dir() {
            return Err(format!("新建图库的父目录不存在：{}", parent.display()));
        }
    }
    Ok(())
}

pub fn resolve_startup(
    app: &AppHandle,
    env_data: Option<String>,
    env_config: Option<String>,
    env_log: Option<String>,
) -> Result<Startup, String> {
    let test_mode = env_data.is_some() || env_config.is_some();

    if let Some(data_dir) = env_data {
        let path = absolute(PathBuf::from(data_dir))?;
        let log_dir = match env_log {
            Some(dir) => absolute(PathBuf::from(dir))?,
            None => path.join("logs"),
        };
        return Ok(Startup {
            test_mode,
            config_path: None,
            library: Some(LibrarySelection {
                path,
                mode: LibraryMode::Auto,
            }),
            problem: None,
            notice: None,
            log_dir,
        });
    }

    let config_path = match env_config {
        Some(raw) => absolute(PathBuf::from(raw))?,
        None => default_config_path(app)?,
    };
    let log_dir = match env_log {
        Some(dir) => absolute(PathBuf::from(dir))?,
        None => config_path
            .parent()
            .map(|parent| parent.join("logs"))
            .ok_or_else(|| "配置文件没有父目录".to_string())?,
    };

    match read_config(&config_path) {
        Ok(None) => Ok(Startup {
            test_mode,
            config_path: Some(config_path),
            library: None,
            problem: None,
            notice: None,
            log_dir,
        }),
        Ok(Some(library)) => match validate_existing(&library) {
            Ok(()) => Ok(Startup {
                test_mode,
                config_path: Some(config_path),
                library: Some(LibrarySelection {
                    path: library,
                    mode: LibraryMode::Existing,
                }),
                problem: None,
                notice: None,
                log_dir,
            }),
            Err(reason) => Ok(Startup {
                test_mode,
                config_path: Some(config_path),
                library: None,
                problem: Some(LibraryProblem {
                    path: library,
                    reason,
                }),
                notice: None,
                log_dir,
            }),
        },
        Err(notice) => Ok(Startup {
            test_mode,
            config_path: Some(config_path),
            library: None,
            problem: None,
            notice: Some(notice),
            log_dir,
        }),
    }
}

fn query_pair(key: &str, value: &str) -> String {
    format!("{key}={}", backend::percent_encode(value))
}

fn library_url(query: &str) -> String {
    if query.is_empty() {
        "tauri://localhost/library.html".to_string()
    } else {
        format!("tauri://localhost/library.html?{query}")
    }
}

fn navigate(app: &AppHandle, url: String) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    match url.parse::<Url>() {
        Ok(url) => {
            if let Err(err) = window.navigate(url) {
                backend::log_line(app, &format!("navigate failed: {err}"));
                false
            } else {
                true
            }
        }
        Err(err) => {
            backend::log_line(app, &format!("invalid local url {url}: {err}"));
            false
        }
    }
}

fn finish_library_change(app: &AppHandle) {
    let state = app.state::<BackendState>();
    if state
        .library_change_pending
        .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        backend::log_line(app, "library change finished");
    }
}

/// The one entry point used by both the menu and the `imagen-action://` page
/// hook. It is deliberately off the UI thread because the flow can stop and
/// restart the backend.
pub fn request_change_library(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let state = handle.state::<BackendState>();
        if state
            .library_change_pending
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            backend::log_line(&handle, "library change ignored: already in progress");
            return;
        }
        let current = {
            let config = state
                .config
                .read()
                .unwrap_or_else(|p| p.into_inner());
            config.library.as_ref().map(|lib| lib.path.clone())
        };
        let mut query = match current {
            Some(path) => format!(
                "change=1&{}",
                query_pair("path", &path.to_string_lossy())
            ),
            None => String::new(),
        };
        // In a debug build with an injected pick path, auto-select it so the
        // same flow can be exercised without a human at the dialogs.
        if debug_pick_path().is_some() {
            if !query.is_empty() {
                query.push('&');
            }
            query.push_str("auto=existing");
        }
        if !navigate(&handle, library_url(&query)) {
            finish_library_change(&handle);
        }
    });
}

pub fn show_problem(app: &AppHandle, path: &Path, reason: &str) {
    backend::log_line(
        app,
        &format!("library unavailable: {} ({reason})", path.display()),
    );
    let query = format!(
        "error=1&{}&{}",
        query_pair("path", &path.to_string_lossy()),
        query_pair("reason", reason)
    );
    navigate(app, library_url(&query));
}

pub fn show_notice(app: &AppHandle, notice: &str) {
    backend::log_line(app, &format!("library config notice: {notice}"));
    navigate(app, library_url(&query_pair("notice", notice)));
}

fn eval(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.eval(script) {
            backend::log_line(app, &format!("library page eval failed: {err}"));
        }
    }
}

fn eval_notice(app: &AppHandle, message: &str, kind: &str) {
    backend::log_line(app, &format!("library page notice: {message}"));
    let message = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    let kind = serde_json::to_string(kind).unwrap_or_else(|_| "\"info\"".to_string());
    eval(
        app,
        &format!("window.imagenLibraryNotice && window.imagenLibraryNotice({message}, {kind});"),
    );
}

pub fn show_native_error(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("Imagen")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .show(|_| {});
}

fn restore_config(path: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    match previous {
        Some(bytes) => {
            let parent = path.parent().ok_or("配置文件没有父目录")?;
            let tmp = parent.join(format!(
                ".{}.restore.{}",
                path.file_name().and_then(|s| s.to_str()).unwrap_or("desktop.json"),
                std::process::id()
            ));
            fs::write(&tmp, bytes).map_err(|e| format!("无法恢复配置临时文件：{e}"))?;
            fs::rename(&tmp, path).map_err(|e| format!("无法恢复配置文件：{e}"))
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("无法移除新配置：{err}")),
        },
    }
}

fn candidate_valid(path: &Path, mode: LibraryMode) -> Result<(), String> {
    match mode {
        LibraryMode::Existing => validate_existing(path),
        LibraryMode::Create => validate_create(path),
        LibraryMode::Auto => {
            if path.join("app.db").exists() {
                validate_existing(path)
            } else {
                validate_create(path)
            }
        }
    }
}

/// Stop the current backend, validate the candidate, then write config and
/// start the new backend. On validation failure the old library is restarted
/// and its config is left untouched.
pub fn apply_selection(app: &AppHandle, path: PathBuf, mode: LibraryMode) -> Result<(), String> {
    let result = apply_selection_inner(app, path, mode);
    finish_library_change(app);
    result
}

fn apply_selection_inner(
    app: &AppHandle,
    path: PathBuf,
    mode: LibraryMode,
) -> Result<(), String> {
    let (old_library, config_path, was_healthy) = {
        let state = app.state::<BackendState>();
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        (
            config.library.clone(),
            config.config_path.clone(),
            state.healthy.load(std::sync::atomic::Ordering::SeqCst),
        )
    };
    let old_config_bytes = config_path
        .as_ref()
        .and_then(|p| fs::read(p).ok());

    backend::stop_for_library_change(app);

    if let Err(reason) = candidate_valid(&path, mode) {
        backend::log_line(app, &format!("library change rejected: {reason}"));
        if was_healthy {
            backend::restart_current_async(app);
            show_native_error(app, &format!("未更改图库：{reason}\n已继续使用原来的图库。"));
        } else {
            eval_notice(app, &reason, "error");
        }
        return Err(reason);
    }

    if let Some(config_file) = &config_path {
        if let Err(err) = write_config(config_file, &path) {
            if was_healthy {
                backend::restart_current_async(app);
                show_native_error(app, &format!("未更改图库：{err}"));
            } else {
                eval_notice(app, &err, "error");
            }
            return Err(err);
        }
    }

    {
        let state = app.state::<BackendState>();
        let mut config = state
            .config
            .write()
            .unwrap_or_else(|p| p.into_inner());
        config.library = Some(LibrarySelection {
            path: path.clone(),
            mode,
        });
    }

    match backend::spawn(app) {
        Ok(_) => {
            backend::wait_until_healthy(app.clone());
            Ok(())
        }
        Err(err) => {
            if let Some(config_file) = &config_path {
                if let Err(restore_err) = restore_config(config_file, old_config_bytes.as_deref()) {
                    backend::log_line(
                        app,
                        &format!("failed to restore old config after spawn error: {restore_err}"),
                    );
                }
            }
            {
                let state = app.state::<BackendState>();
                let mut config = state
                    .config
                    .write()
                    .unwrap_or_else(|p| p.into_inner());
                config.library = old_library;
            }
            if was_healthy {
                backend::restart_current_async(app);
                show_native_error(app, &format!("无法切换图库：{err}\n已继续使用原来的图库。"));
            } else {
                eval_notice(app, &err, "error");
            }
            Err(err)
        }
    }
}

#[cfg(debug_assertions)]
fn debug_pick_path() -> Option<PathBuf> {
    nonempty_env("IMAGEN_DEV_PICK_PATH").map(PathBuf::from).and_then(|p| {
        if p.is_absolute() {
            Some(p)
        } else {
            env::current_dir().ok().map(|cwd| cwd.join(p))
        }
    })
}

#[cfg(not(debug_assertions))]
fn debug_pick_path() -> Option<PathBuf> {
    None
}

#[cfg(debug_assertions)]
pub fn auto_pick_action() -> Option<LibraryMode> {
    nonempty_env("IMAGEN_DEV_LIBRARY_ACTION")
        .as_deref()
        .and_then(LibraryMode::parse)
        .filter(|mode| matches!(mode, LibraryMode::Existing | LibraryMode::Create))
}

#[cfg(not(debug_assertions))]
pub fn auto_pick_action() -> Option<LibraryMode> {
    None
}

#[cfg(debug_assertions)]
pub fn auto_change_action() -> Option<LibraryMode> {
    nonempty_env("IMAGEN_DEV_LIBRARY_CHANGE")
        .as_deref()
        .and_then(LibraryMode::parse)
        .filter(|mode| matches!(mode, LibraryMode::Existing | LibraryMode::Create))
}

pub fn navigate_auto_pick(app: &AppHandle, mode: LibraryMode) {
    navigate(app, library_url(&format!("auto={}", mode.as_str())));
}

#[cfg(debug_assertions)]
pub fn navigate_auto_change(app: &AppHandle, mode: LibraryMode) {
    let path = {
        let state = app.state::<BackendState>();
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        config.library.as_ref().map(|lib| lib.path.clone())
    };
    let mut query = format!("change=1&auto={}", mode.as_str());
    if let Some(path) = path {
        query.push('&');
        query.push_str(&query_pair("path", &path.to_string_lossy()));
    }
    navigate(app, library_url(&query));
}

pub fn maybe_auto_change(app: &AppHandle) {
    #[cfg(debug_assertions)]
    {
        if let Some(mode) = auto_change_action() {
            let state = app.state::<BackendState>();
            if !state.auto_change_done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                navigate_auto_change(app, mode);
            }
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
}

pub fn choose_library(app: AppHandle, mode: String) -> Result<(), String> {
    let mode = LibraryMode::parse(&mode)
        .filter(|mode| matches!(mode, LibraryMode::Existing | LibraryMode::Create))
        .ok_or_else(|| format!("无效的图库模式：{mode}"))?;

    if let Some(path) = debug_pick_path() {
        let handle = app.clone();
        thread::spawn(move || {
            if let Err(err) = apply_selection(&handle, path, mode) {
                backend::log_line(&handle, &format!("library selection failed: {err}"));
            }
        });
        return Ok(());
    }

    let handle = app.clone();
    app.dialog()
        .file()
        .set_title(match mode {
            LibraryMode::Create => "选择空文件夹以新建 Imagen 图库",
            _ => "选择已有的 Imagen 图库",
        })
        .pick_folder(move |picked| match picked.and_then(|p| p.into_path().ok()) {
            Some(path) => {
                let handle = handle.clone();
                thread::spawn(move || {
                    if let Err(err) = apply_selection(&handle, path, mode) {
                        backend::log_line(&handle, &format!("library selection failed: {err}"));
                    }
                });
            }
            None => {
                finish_library_change(&handle);
                eval_notice(&handle, "已取消选择。", "info");
            }
        });
    Ok(())
}

pub fn retry_library(app: AppHandle) -> Result<(), String> {
    finish_library_change(&app);
    let (config_path, library) = {
        let state = app.state::<BackendState>();
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        (config.config_path.clone(), config.library.clone())
    };
    if let Some(library) = library {
        if backend::is_healthy(&app) {
            backend::navigate_to_app(&app);
            return Ok(());
        }
        let handle = app.clone();
        thread::spawn(move || {
            if let Err(err) = apply_selection(&handle, library.path, LibraryMode::Existing) {
                backend::log_line(&handle, &format!("library retry failed: {err}"));
            }
        });
        return Ok(());
    }
    let Some(config_file) = config_path else {
        eval_notice(&app, "没有可重试的配置文件。", "error");
        return Ok(());
    };
    let path = match read_config(&config_file) {
        Ok(Some(path)) => path,
        Ok(None) => {
            eval_notice(&app, "配置文件不存在。", "error");
            return Ok(());
        }
        Err(err) => {
            eval_notice(&app, &err, "error");
            return Ok(());
        }
    };
    let handle = app.clone();
    thread::spawn(move || {
        if let Err(err) = apply_selection(&handle, path, LibraryMode::Existing) {
            backend::log_line(&handle, &format!("library retry failed: {err}"));
        }
    });
    Ok(())
}

pub fn reveal_config(app: AppHandle) -> Result<(), String> {
    let config_path = {
        let state = app.state::<BackendState>();
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        config.config_path.clone()
    };
    let Some(path) = config_path else {
        return Err("当前测试模式没有配置文件。".to_string());
    };
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("无法打开 Finder：{e}"))?;
    if !status.success() {
        if let Some(parent) = path.parent() {
            let parent_status = Command::new("open")
                .arg(parent)
                .status()
                .map_err(|e| format!("无法打开 Finder：{e}"))?;
            if parent_status.success() {
                return Ok(());
            }
        }
        return Err(format!("Finder 返回失败：{status}"));
    }
    Ok(())
}

pub fn return_to_current(app: AppHandle) -> Result<(), String> {
    finish_library_change(&app);
    if backend::is_healthy(&app) {
        backend::navigate_to_app(&app);
        Ok(())
    } else {
        Err("当前图库的后端未运行。".to_string())
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Recently opened libraries from `ui.json`, newest first. Empty in data-dir
/// test mode (no `ui.json`).
pub fn recent_libraries(app: &AppHandle) -> Vec<(PathBuf, u64)> {
    let Some(path) = ui_store::ui_path(app) else {
        return Vec::new();
    };
    let Some(map) = ui_store::read_object(&path) else {
        return Vec::new();
    };
    map.get(RECENT_KEY)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let raw = item.get("path")?.as_str()?;
                    let path = PathBuf::from(raw);
                    path.is_absolute().then(|| {
                        let at = item.get("opened_at").and_then(serde_json::Value::as_u64);
                        (path, at.unwrap_or(0))
                    })
                })
                .take(MAX_RECENT)
                .collect()
        })
        .unwrap_or_default()
}

/// Move `library` to the front of the recent list (called once its backend is
/// healthy).
pub fn record_recent(app: &AppHandle, library: &Path) {
    let Some(ui) = ui_store::ui_path(app) else {
        return;
    };
    let mut list = recent_libraries(app);
    list.retain(|(path, _)| path != library);
    list.insert(0, (library.to_path_buf(), now_secs()));
    list.truncate(MAX_RECENT);
    let value: Vec<serde_json::Value> = list
        .iter()
        .map(|(path, at)| json!({ "path": path.to_string_lossy(), "opened_at": at }))
        .collect();
    if let Err(err) = ui_store::update(&ui, |map| {
        map.insert(RECENT_KEY.to_string(), serde_json::Value::Array(value));
    }) {
        backend::log_line(app, &format!("recent libraries write failed: {err}"));
    }
    refresh_recent_menu(app);
}

fn current_library(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<BackendState>();
    let config = state.config.read().unwrap_or_else(|p| p.into_inner());
    config.library.as_ref().map(|lib| lib.path.clone())
}

/// Rebuild App menu › 打开最近的图库 from ui.json. The current library is
/// shown checked and disabled; a missing folder is disabled.
pub fn refresh_recent_menu(app: &AppHandle) {
    let Some(menu) = app.menu() else {
        return;
    };
    // `get` only looks one level down; the submenu sits inside the app menu.
    let found = menu.items().ok().and_then(|items| {
        items.iter().find_map(|top| {
            top.as_submenu()
                .and_then(|sub| sub.get(RECENT_MENU_ID))
                .and_then(|kind| kind.as_submenu().cloned())
        })
    });
    let Some(submenu) = found else {
        backend::log_line(app, "recent menu missing");
        return;
    };
    let result = (|| -> tauri::Result<()> {
        let submenu = &submenu;
        for item in submenu.items()? {
            submenu.remove(&item)?;
        }
        let current = current_library(app).and_then(|p| fs::canonicalize(p).ok());
        let recents = recent_libraries(app);
        for (index, (path, _)) in recents.iter().enumerate() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            let label = format!("{name}  —  {}", path.display());
            let is_current = current.is_some() && fs::canonicalize(path).ok() == current;
            let exists = path.join("app.db").is_file();
            let item = CheckMenuItem::with_id(
                app,
                format!("{RECENT_MENU_ID}/{index}"),
                label,
                exists && !is_current,
                is_current,
                None::<&str>,
            )?;
            submenu.append(&item)?;
        }
        submenu.set_enabled(!recents.is_empty())?;
        backend::log_line(app, &format!("recent menu: {} item(s)", recents.len()));
        Ok(())
    })();
    if let Err(err) = result {
        backend::log_line(app, &format!("recent menu refresh failed: {err}"));
    }
}

/// Recent index from Settings, the menu, or the action URL: one switch at a time.
fn open_recent_guarded(app: &AppHandle, index: usize) {
    let state = app.state::<BackendState>();
    if state
        .library_change_pending
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        backend::log_line(app, "library change ignored: already in progress");
        return;
    }
    if let Err(err) = open_recent(app.clone(), index) {
        finish_library_change(app);
        show_native_error(app, &err);
    }
}

/// For the startup page: name, path, last opened (unix seconds), and whether
/// the folder is reachable right now.
pub fn list_recent(app: AppHandle) -> Vec<serde_json::Value> {
    recent_libraries(&app)
        .into_iter()
        .map(|(path, at)| {
            json!({
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "opened_at": at,
                "exists": path.join("app.db").is_file(),
            })
        })
        .collect()
}

/// A library path typed by the user (for people who don't know ⌘⇧G).
/// Accepts `~`, surrounding quotes, shell-escaped spaces, and a path to
/// `app.db` itself; the result must be an existing library.
pub fn typed_library_path(raw: &str) -> Result<PathBuf, String> {
    let mut text = raw.trim();
    for quote in ['"', '\'', '“'] {
        let close = if quote == '“' { '”' } else { quote };
        if text.len() >= 2 && text.starts_with(quote) && text.ends_with(close) {
            text = text[quote.len_utf8()..text.len() - close.len_utf8()].trim();
            break;
        }
    }
    if text.is_empty() {
        return Err("请输入图库文件夹的路径。".to_string());
    }
    let unescaped = text.replace("\\ ", " ");
    let expanded = if unescaped == "~" || unescaped.starts_with("~/") {
        let home = env::var("HOME").map_err(|_| "无法确定主目录，请输入完整路径。".to_string())?;
        PathBuf::from(home).join(unescaped.trim_start_matches('~').trim_start_matches('/'))
    } else {
        PathBuf::from(&unescaped)
    };
    if !expanded.is_absolute() {
        return Err("请输入以 / 或 ~ 开头的完整路径。".to_string());
    }
    let dir = if expanded.file_name().is_some_and(|n| n == "app.db") && expanded.is_file() {
        expanded.parent().map(Path::to_path_buf).unwrap_or(expanded)
    } else {
        expanded
    };
    validate_existing(&dir)?;
    fs::canonicalize(&dir).map_err(|e| format!("图库不可用：{}：{e}", dir.display()))
}

/// Startup page: open a typed path. Errors go back to the page inline.
pub fn open_library_path(app: AppHandle, path: String) -> Result<(), String> {
    let dir = typed_library_path(&path)?;
    switch_to(app, dir, LibraryMode::Existing);
    Ok(())
}

/// Settings: the path came from a URL, so it is validated and then confirmed
/// in a native dialog; the page alone can never switch the library.
fn open_path_from_settings(app: &AppHandle, raw: &str) {
    let dir = match typed_library_path(raw) {
        Ok(dir) => dir,
        Err(err) => {
            show_native_error(app, &err);
            return;
        }
    };
    let state = app.state::<BackendState>();
    if state
        .library_change_pending
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        backend::log_line(app, "library change ignored: already in progress");
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(format!("切换到这个图库？\n\n{}", dir.display()))
        .title("打开图库")
        .kind(tauri_plugin_dialog::MessageDialogKind::Info)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "打开".to_string(),
            "取消".to_string(),
        ))
        .show(move |ok| {
            if ok {
                switch_to(handle, dir, LibraryMode::Existing);
            } else {
                backend::log_line(&handle, "typed library path cancelled");
                finish_library_change(&handle);
            }
        });
}

/// The `p` value of `imagen-action://open-path?p=…`, nothing else allowed.
fn open_path_param(url: &Url) -> Option<String> {
    if url.scheme() != ACTION_SCHEME
        || url.host_str() != Some(OPEN_PATH_ACTION)
        || !url.path().is_empty()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if key != "p" || pairs.next().is_some() {
        return None;
    }
    Some(value.into_owned())
}

/// Switch to a recent library by index (startup page and Settings).
pub fn open_recent(app: AppHandle, index: usize) -> Result<(), String> {
    let Some((path, _)) = recent_libraries(&app).into_iter().nth(index) else {
        return Err("最近使用列表里没有这一项。".to_string());
    };
    switch_to(app, path, LibraryMode::Existing);
    Ok(())
}

/// Show the switching page, then stop/validate/start off the UI thread.
fn switch_to(app: AppHandle, path: PathBuf, mode: LibraryMode) {
    let query = format!("switching=1&{}", query_pair("path", &path.to_string_lossy()));
    navigate(&app, library_url(&query));
    thread::spawn(move || {
        if let Err(err) = apply_selection(&app, path, mode) {
            backend::log_line(&app, &format!("library switch failed: {err}"));
        }
    });
}

/// Settings › Library › Open/Create: the native dialog opens over the running
/// app; cancelling leaves everything as it was.
fn pick_from_settings(app: &AppHandle, mode: LibraryMode) {
    let state = app.state::<BackendState>();
    if state
        .library_change_pending
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        backend::log_line(app, "library change ignored: already in progress");
        return;
    }
    if let Some(path) = debug_pick_path() {
        switch_to(app.clone(), path, mode);
        return;
    }
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title(match mode {
            LibraryMode::Create => "选择空文件夹以新建 Imagen 图库",
            _ => "选择已有的 Imagen 图库",
        })
        .pick_folder(move |picked| match picked.and_then(|p| p.into_path().ok()) {
            Some(path) => switch_to(handle, path, mode),
            None => {
                backend::log_line(&handle, "library pick cancelled from settings");
                finish_library_change(&handle);
            }
        });
}

fn recent_index(url: &Url) -> Option<usize> {
    if url.scheme() != ACTION_SCHEME
        || url.host_str() != Some(OPEN_RECENT_ACTION)
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let digits = url.path().strip_prefix('/')?;
    if digits.is_empty() || digits.len() > 2 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Only fixed, parameterless actions (plus a numeric recent index) are
/// accepted. A path is never
/// parsed from this URL; the library comes from the validated config state.
fn is_fixed_action(url: &Url, action: &str) -> bool {
    url.scheme() == ACTION_SCHEME
        && url.host_str() == Some(action)
        && url.path().is_empty()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

pub fn handle_action_url(app: &AppHandle, url: &Url) {
    if is_fixed_action(url, CHANGE_LIBRARY_ACTION) {
        backend::log_line(app, "imagen action: change-library");
        request_change_library(app);
        return;
    }
    if is_fixed_action(url, REVEAL_LIBRARY_ACTION) {
        backend::log_line(app, "imagen action: reveal-library");
        let handle = app.clone();
        thread::spawn(move || {
            if let Err(err) = reveal_library(&handle) {
                backend::log_line(&handle, &format!("reveal library failed: {err}"));
            }
        });
        return;
    }
    for (action, mode) in [
        (OPEN_LIBRARY_ACTION, LibraryMode::Existing),
        (CREATE_LIBRARY_ACTION, LibraryMode::Create),
    ] {
        if is_fixed_action(url, action) {
            backend::log_line(app, &format!("imagen action: {action}"));
            pick_from_settings(app, mode);
            return;
        }
    }
    if let Some(raw) = open_path_param(url) {
        backend::log_line(app, "imagen action: open-path");
        open_path_from_settings(app, &raw);
        return;
    }
    if let Some(index) = recent_index(url) {
        backend::log_line(app, &format!("imagen action: open-recent {index}"));
        open_recent_guarded(app, index);
        return;
    }
    backend::log_line(app, &format!("imagen action ignored: {url}"));
}

pub fn reveal_library(app: &AppHandle) -> Result<(), String> {
    let path = {
        let state = app.state::<BackendState>();
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        config.library.as_ref().map(|lib| lib.path.clone())
    };
    let Some(path) = path else {
        return Err("尚未选择图库。".to_string());
    };
    backend::log_line(app, &format!("reveal library: open -R {}", path.display()));
    #[cfg(debug_assertions)]
    if env::var("IMAGEN_DEV_REVEAL_DRY_RUN")
        .ok()
        .as_deref()
        == Some("1")
    {
        backend::log_line(app, "reveal library dry-run: skipped open");
        return Ok(());
    }
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("无法打开 Finder：{e}"))?;
    if !status.success() {
        return Err(format!("Finder 返回失败：{status}"));
    }
    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == CHANGE_LIBRARY_MENU_ID {
        request_change_library(app);
        return;
    }
    if let Some(index) = event
        .id()
        .as_ref()
        .strip_prefix(RECENT_MENU_ID)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|n| n.parse::<usize>().ok())
    {
        backend::log_line(app, &format!("menu: open-recent {index}"));
        // A CheckMenuItem toggles itself on click; the rebuild after the
        // switch (or right now on refusal) puts the marks back.
        open_recent_guarded(app, index);
        refresh_recent_menu(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let mut f = File::create(dir.join("app.db")).unwrap();
        f.write_all(SQLITE_HEADER).unwrap();
    }

    #[test]
    fn typed_path_variants() {
        let root = env::temp_dir().join(format!("imagen-typed-{}", std::process::id()));
        let lib = root.join("My Library");
        library(&lib);
        let want = fs::canonicalize(&lib).unwrap();
        let plain = lib.to_string_lossy().to_string();
        for raw in [
            plain.clone(),
            format!("  {plain}  "),
            format!("\"{plain}\""),
            format!("'{plain}'"),
            plain.replace(' ', "\\ "),
            format!("{plain}/app.db"),
        ] {
            assert_eq!(typed_library_path(&raw).unwrap(), want, "{raw}");
        }
        assert!(typed_library_path("").is_err());
        assert!(typed_library_path("relative/dir").is_err());
        assert!(typed_library_path(&root.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn open_path_url_shape() {
        let ok = Url::parse("imagen-action://open-path?p=%2FUsers%2Fa%20b").unwrap();
        assert_eq!(open_path_param(&ok).as_deref(), Some("/Users/a b"));
        for bad in [
            "imagen-action://open-path?p=/a&x=1",
            "imagen-action://open-path?q=/a",
            "imagen-action://open-path/x?p=/a",
            "imagen-action://open-library?p=/a",
            "https://open-path?p=/a",
        ] {
            assert!(open_path_param(&Url::parse(bad).unwrap()).is_none(), "{bad}");
        }
    }
}
