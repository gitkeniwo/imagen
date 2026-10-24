//! Supervises the bundled Python backend: spawn, health-check, monitor, stop.
//!
//! The backend is a child process with a piped stdin. Dropping our stdin handle
//! (normal quit, shell crash, or `kill -9` on the shell) closes the pipe, the
//! backend reads EOF, and exits on its own — so no orphans are left behind.

use std::env;
use std::fmt::Write as FmtWrite;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write as IoWrite};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

use crate::library::{self, LibraryProblem, LibrarySelection};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub const DEFAULT_PORT: u16 = 47860;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL: Duration = Duration::from_millis(100);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct BackendConfig {
    pub port: u16,
    pub token: String,
    pub library: Option<LibrarySelection>,
    pub config_path: Option<PathBuf>,
    pub log_dir: PathBuf,
    pub backend_log: PathBuf,
    pub shell_log: PathBuf,
    pub test_mode: bool,
}

pub struct BackendState {
    pub config: RwLock<BackendConfig>,
    pub startup_problem: Option<LibraryProblem>,
    pub startup_notice: Option<String>,
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub auto_change_done: AtomicBool,
    pub library_change_pending: AtomicBool,
    pub child: Mutex<Option<Child>>,
    pub stdin: Mutex<Option<ChildStdin>>,
    pub started: Mutex<Option<Instant>>,
    /// Set while we intentionally stop the child (restart or final quit).
    pub expected_exit: AtomicBool,
    /// Set once the app is really quitting; background threads bail out.
    pub exiting: AtomicBool,
    pub healthy: AtomicBool,
    /// Ensures only one monitor thread watches the current child.
    pub monitor_running: AtomicBool,
    /// Incremented on every spawn so stale health-wait threads stop early.
    pub generation: AtomicU64,
}

impl BackendState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let raw_port = env::var("IMAGEN_PORT").unwrap_or_default();
        let port = if raw_port.trim().is_empty() {
            DEFAULT_PORT
        } else {
            raw_port
                .trim()
                .parse::<u16>()
                .map_err(|_| format!("IMAGEN_PORT 无效：{raw_port}"))?
        };
        if port == 0 {
            return Err("IMAGEN_PORT 不能为 0".to_string());
        }

        let env_data = env::var("IMAGEN_DATA_DIR")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let env_config = env::var("IMAGEN_CONFIG_PATH")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let env_log = env::var("IMAGEN_LOG_DIR")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let startup = library::resolve_startup(app, env_data, env_config, env_log)?;
        let log_dir = startup.log_dir.clone();
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("无法创建日志目录 {log_dir:?}：{e}"))?;

        Ok(Self {
            config: RwLock::new(BackendConfig {
                port,
                token: random_token(),
                library: startup.library,
                config_path: startup.config_path,
                backend_log: log_dir.join("backend.log"),
                shell_log: log_dir.join("shell.log"),
                log_dir,
                test_mode: startup.test_mode,
            }),
            startup_problem: startup.problem,
            startup_notice: startup.notice,
            auto_change_done: AtomicBool::new(false),
            library_change_pending: AtomicBool::new(false),
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            started: Mutex::new(None),
            expected_exit: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            healthy: AtomicBool::new(false),
            monitor_running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        })
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    let filled = File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    if !filled {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        let mut x = nanos ^ (u64::from(std::process::id()) << 32) | 1;
        for b in &mut bytes {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
    }
    let mut out = String::with_capacity(32);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append one line to the shell log (and stderr, which lands in backend.log's
/// sibling when the shell is launched from a terminal). Never panics.
pub fn log_line(app: &AppHandle, message: &str) {
    let stamp = epoch_ms();
    eprintln!("imagen[{stamp}]: {message}");
    if let Some(state) = app.try_state::<BackendState>() {
        let shell_log = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .shell_log
            .clone();
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(shell_log)
        {
            let _ = writeln!(f, "[{stamp}] {message}");
        }
    }
}

#[cfg(debug_assertions)]
fn backend_repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend")
}

fn backend_command(app: &AppHandle) -> Result<Command, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        if let Ok(cmd) = env::var("IMAGEN_DEV_BACKEND_CMD") {
            let cmd = cmd.trim();
            if !cmd.is_empty() {
                let mut c = Command::new("/bin/sh");
                // `exec` makes the shell replace itself, so the PID we hold is
                // the backend and signals/EOF reach it directly.
                c.arg("-c")
                    .arg(format!("exec {cmd}"))
                    .current_dir(backend_repo_dir());
                return Ok(c);
            }
        }
        let mut c = Command::new("uv");
        c.args(["run", "--frozen", "python", "-m", "app.desktop"])
            .current_dir(backend_repo_dir());
        Ok(c)
    }
    #[cfg(not(debug_assertions))]
    {
        let dir = app
            .path()
            .resolve(
                "imagen-backend",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("无法定位内置后端目录：{e}"))?;
        let bin = dir.join("imagen-backend");
        if !bin.is_file() {
            return Err(format!("内置后端不存在：{}", bin.display()));
        }
        let mut c = Command::new(&bin);
        c.current_dir(&dir);
        Ok(c)
    }
}

/// Start the backend if it is not already running. Returns its PID.
pub fn spawn(app: &AppHandle) -> Result<u32, String> {
    let state = app.state::<BackendState>();

    {
        let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(child.id()),
                Ok(Some(_)) | Err(_) => *guard = None,
            }
        }
    }

    let (config, library) = {
        let config = state
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner());
        (config.clone(), config.library.clone())
    };
    let library = library.ok_or_else(|| "尚未选择图库".to_string())?;
    let mut cmd = backend_command(app)?;
    cmd.env("IMAGEN_DATA_DIR", &library.path)
        .env("IMAGEN_LIBRARY_MODE", library.mode.as_str())
        .env("IMAGEN_PORT", config.port.to_string())
        .env("IMAGEN_INSTANCE_TOKEN", &config.token)
        .env("IMAGEN_PARENT_WATCH", "1")
        .env("IMAGEN_LOG_DIR", &config.log_dir)
        .stdin(Stdio::piped());
    // Settings reads the recent-library list from here (read-only).
    if let Some(ui) = crate::ui_store::ui_path(app) {
        cmd.env("IMAGEN_UI_PATH", ui);
    }
    // The backend owns remote.json (LAN access settings); it lives with the
    // desktop config, never inside the library.
    if let Some(remote) = crate::ui_store::remote_path(app) {
        cmd.env("IMAGEN_REMOTE_PATH", remote);
    }

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.backend_log)
        .map_err(|e| format!("无法打开后端日志 {}：{e}", config.backend_log.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("无法复制后端日志句柄：{e}"))?;
    cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动后端进程：{e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();

    *state.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    *state.stdin.lock().unwrap_or_else(|p| p.into_inner()) = stdin;
    *state.started.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    state.expected_exit.store(false, Ordering::SeqCst);
    state.healthy.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);

    crate::tray::refresh_now(app);
    log_line(
        app,
        &format!(
            "backend spawned pid={pid} port={} data_dir={} mode={} test_mode={}",
            config.port,
            library.path.display(),
            library.mode.as_str(),
            config.test_mode
        ),
    );
    Ok(pid)
}

fn child_status(app: &AppHandle) -> Option<ExitStatus> {
    let state = app.state::<BackendState>();
    let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_mut().and_then(|c| c.try_wait().ok().flatten())
}

/// One minimal HTTP/1.1 JSON request against the loopback backend.
///
/// No client library on purpose: the shell only ever talks to its own child on
/// 127.0.0.1, so a few lines over a raw TcpStream are enough. Returns the
/// status code plus the parsed JSON body, or None when the socket or the body
/// is not usable (backend down, timeout, non-JSON error page).
pub fn http_json(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<(u16, Value)> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n"
    );
    if body.is_some() {
        let _ = write!(
            request,
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        );
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    if !payload.is_empty() {
        stream.write_all(payload.as_bytes()).ok()?;
    }
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let (head, rest) = raw.split_once("\r\n\r\n")?;
    let status = head
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let value = serde_json::from_str(rest).ok()?;
    Some((status, value))
}

fn http_health(port: u16) -> Option<Value> {
    let (status, body) = http_json(port, "GET", "/api/health", None)?;
    (status == 200).then_some(body)
}

pub fn navigate_to_app(app: &AppHandle) {
    let port = app
        .state::<BackendState>()
        .config
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .port;
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(debug_assertions)]
        let path = {
            let raw = env::var("IMAGEN_DEV_START_PATH").unwrap_or_default();
            let raw = raw.trim();
            if raw.is_empty() {
                "/".to_string()
            } else if raw.starts_with('/') {
                raw.to_string()
            } else {
                format!("/{raw}")
            }
        };
        #[cfg(not(debug_assertions))]
        let path = "/".to_string();

        // A versioned URL keeps the webview's HTTP cache from serving an
        // `index.html` left over from a previous release. (The backend also
        // marks HTML `no-store`; this covers caches primed before that fix
        // landed, and any webview that ignores the header.)
        let sep = if path.contains('?') { '&' } else { '?' };
        let target = format!(
            "http://127.0.0.1:{port}{path}{sep}v={}",
            env!("CARGO_PKG_VERSION")
        );
        match target.parse::<Url>() {
            Ok(url) => {
                if let Err(e) = window.navigate(url) {
                    log_line(app, &format!("navigate to app failed: {e}"));
                }
            }
            Err(e) => log_line(app, &format!("invalid app url {target}: {e}")),
        }
    }
}

pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

/// Show the error page in the main window and a native dialog with the log path.
pub fn show_error(app: &AppHandle, message: &str) {
    log_line(app, &format!("ERROR {message}"));
    let log_path = app
        .try_state::<BackendState>()
        .map(|s| {
            s.config
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .backend_log
                .display()
                .to_string()
        })
        .unwrap_or_default();

    if let Some(window) = app.get_webview_window("main") {
        let target = format!(
            "tauri://localhost/error.html?msg={}&log={}",
            percent_encode(message),
            percent_encode(&log_path)
        );
        match target.parse::<Url>() {
            Ok(url) => {
                if let Err(e) = window.navigate(url) {
                    log_line(app, &format!("navigate to error page failed: {e}"));
                }
            }
            Err(e) => log_line(app, &format!("invalid error url: {e}")),
        }
    }

    app.dialog()
        .message(format!("{message}\n\n日志：{log_path}"))
        .title("Imagen")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// Poll `/api/health` until the token matches, then navigate to the UI.
pub fn wait_until_healthy(app: AppHandle) {
    let (port, token, generation, started, log_path, library_path) = {
        let state = app.state::<BackendState>();
        let started = *state.started.lock().unwrap_or_else(|p| p.into_inner());
        let config = state.config.read().unwrap_or_else(|p| p.into_inner());
        (
            config.port,
            config.token.clone(),
            state.generation.load(Ordering::SeqCst),
            started.unwrap_or_else(Instant::now),
            config.backend_log.display().to_string(),
            config.library.as_ref().map(|lib| lib.path.clone()),
        )
    };

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        {
            let state = app.state::<BackendState>();
            if state.exiting.load(Ordering::SeqCst)
                || state.generation.load(Ordering::SeqCst) != generation
            {
                return;
            }
        }

        if let Some(status) = child_status(&app) {
            if !app.state::<BackendState>().expected_exit.load(Ordering::SeqCst) {
                show_backend_exit(&app, status, library_path.as_deref(), &log_path);
            }
            return;
        }

        if let Some(body) = http_health(port) {
            let app_ok = body.get("app").and_then(Value::as_str) == Some("imagen");
            let token_ok = body.get("token").and_then(Value::as_str) == Some(token.as_str());
            if app_ok && token_ok {
                app.state::<BackendState>()
                    .healthy
                    .store(true, Ordering::SeqCst);
                let elapsed = started.elapsed().as_millis();
                log_line(
                    &app,
                    &format!("health ok in {elapsed} ms; navigating to 127.0.0.1:{port}"),
                );
                navigate_to_app(&app);
                if let Some(path) = library_path.as_deref() {
                    library::record_recent(&app, path);
                }
                library::maybe_auto_change(&app);
                crate::tray::refresh_now(&app);
                spawn_monitor(app.clone());
                return;
            }
        }

        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(HEALTH_POLL);
    }

    if let Some(path) = library_path.as_deref() {
        library::show_problem(
            &app,
            path,
            &format!("20 秒内未通过健康检查；端口 {port} 可能被占用，或后端启动失败。日志：{log_path}"),
        );
    } else {
        show_error(
            &app,
            &format!(
                "20 秒内未通过健康检查：端口 {port} 可能被其他进程占用，或后端启动失败。\n日志：{log_path}"
            ),
        );
    }
}

fn backend_failure_reason(app: &AppHandle) -> String {
    let log_path = app
        .try_state::<BackendState>()
        .map(|s| {
            s.config
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .backend_log
                .clone()
        });
    let Some(log_path) = log_path else {
        return "后端启动失败".to_string();
    };
    fs::read_to_string(log_path)
        .ok()
        .and_then(|text| {
            text.lines()
                .rev()
                .find(|line| line.contains("fatal:"))
                .map(|line| line.split("fatal:").nth(1).unwrap_or(line).trim().to_string())
        })
        .filter(|reason| !reason.is_empty())
        .unwrap_or_else(|| "后端启动失败（详见日志）".to_string())
}

fn show_backend_exit(
    app: &AppHandle,
    status: ExitStatus,
    library_path: Option<&std::path::Path>,
    log_path: &str,
) {
    match (status.code(), library_path) {
        (Some(3), Some(path)) => {
            let reason = backend_failure_reason(app);
            log_line(app, &format!("library validation failed: {reason}"));
            library::show_problem(app, path, &reason);
        }
        (Some(4), Some(path)) => {
            let reason = "图库正被另一个 Imagen 使用";
            log_line(app, reason);
            library::show_problem(app, path, reason);
        }
        _ => show_error(app, &format!("后端已退出（{status}）。\n日志：{log_path}")),
    }
}

fn spawn_monitor(app: AppHandle) {
    if app
        .state::<BackendState>()
        .monitor_running
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(500));
            if app.state::<BackendState>().exiting.load(Ordering::SeqCst) {
                break;
            }
            if let Some(status) = child_status(&app) {
                if !app
                    .state::<BackendState>()
                    .expected_exit
                    .load(Ordering::SeqCst)
                {
                    log_line(&app, &format!("后端已退出（{status}）"));
                    let library_path = app
                        .state::<BackendState>()
                        .config
                        .read()
                        .unwrap_or_else(|p| p.into_inner())
                        .library
                        .as_ref()
                        .map(|lib| lib.path.clone());
                    let log_path = app
                        .state::<BackendState>()
                        .config
                        .read()
                        .unwrap_or_else(|p| p.into_inner())
                        .backend_log
                        .display()
                        .to_string();
                    show_backend_exit(&app, status, library_path.as_deref(), &log_path);
                    break;
                }
            }
        }
        app.state::<BackendState>()
            .monitor_running
            .store(false, Ordering::SeqCst);
    });
}

fn stop_child(app: &AppHandle, expected: bool) {
    let state = app.state::<BackendState>();
    state.expected_exit.store(expected, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);

    // Closing the pipe is the graceful path: the backend sees stdin EOF.
    let stdin = state
        .stdin
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    drop(stdin);

    let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(child) = guard.as_mut() {
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        log_line(app, "backend did not exit within 5s; killing");
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    }
    *guard = None;
    state.healthy.store(false, Ordering::SeqCst);
    crate::tray::refresh_now(app);
}


pub fn is_healthy(app: &AppHandle) -> bool {
    app.state::<BackendState>().healthy.load(Ordering::SeqCst)
}

/// Port the child listens on (loopback).
pub fn port(app: &AppHandle) -> u16 {
    app.state::<BackendState>()
        .config
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .port
}

pub fn has_library(app: &AppHandle) -> bool {
    app.state::<BackendState>()
        .config
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .library
        .is_some()
}

pub fn test_mode(app: &AppHandle) -> bool {
    app.state::<BackendState>()
        .config
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .test_mode
}

pub fn log_dir(app: &AppHandle) -> PathBuf {
    app.state::<BackendState>()
        .config
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .log_dir
        .clone()
}

/// True while the child process still exists (it may not be healthy yet).
pub fn child_running(app: &AppHandle) -> bool {
    let state = app.state::<BackendState>();
    let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Shell view of the backend: `starting` (child up, health not yet confirmed),
/// `healthy`, or `stopped` (exited / never started).
pub fn shell_status(app: &AppHandle) -> &'static str {
    if is_healthy(app) {
        "healthy"
    } else if child_running(app) {
        "starting"
    } else {
        "stopped"
    }
}

/// Gracefully stop the current child before a library change. The config is
/// not modified here; the caller validates the candidate first.
pub fn stop_for_library_change(app: &AppHandle) {
    log_line(app, "stopping backend for library change");
    stop_child(app, true);
}

/// Restart the current (still configured) library after a rejected change.
pub fn restart_current_async(app: &AppHandle) {
    match spawn(app) {
        Ok(pid) => {
            log_line(app, &format!("old backend restarted pid={pid}"));
            let handle = app.clone();
            thread::spawn(move || wait_until_healthy(handle));
        }
        Err(err) => {
            log_line(app, &format!("old backend restart failed: {err}"));
            show_error(app, &err);
        }
    }
}

/// Restart the backend from the error page's button.
pub fn restart_backend(app: &AppHandle) -> Result<(), String> {
    log_line(app, "restart requested from error page");
    stop_child(app, true);
    match spawn(app) {
        Ok(pid) => {
            log_line(app, &format!("backend restarted pid={pid}"));
            let handle = app.clone();
            thread::spawn(move || wait_until_healthy(handle));
            Ok(())
        }
        Err(e) => {
            app.state::<BackendState>()
                .expected_exit
                .store(false, Ordering::SeqCst);
            show_error(app, &e);
            Err(e)
        }
    }
}

/// Final shutdown, called from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    {
        let state = app.state::<BackendState>();
        state.exiting.store(true, Ordering::SeqCst);
    }
    log_line(app, "shell exiting; closing backend stdin");
    stop_child(app, true);
    log_line(app, "backend stopped");
}

pub fn navigation_allowed(url: &Url, port: u16) -> bool {
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}
