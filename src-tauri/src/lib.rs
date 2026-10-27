//! Native shell for the Personal Finance app.
//!
//! This file does only four jobs; everything else lives in the Node backend and the React UI:
//!   1. allow a single running instance of the app,
//!   2. start the backend "sidecar" program on a free local port with a random per-launch token,
//!   3. open the window and tell the UI where the backend is and which token to use,
//!   4. stop the backend when the app exits.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Preferred backend port, so a bookmarked browser-tab address keeps working between launches.
const DEFAULT_PORT: u16 = 47831;

/// Holds the running backend so it can be stopped when the app exits.
struct Backend(Mutex<Option<CommandChild>>);

/// What the UI needs to talk to the backend (injected into the page as `window.__PF__`).
struct Bootstrap {
    port: u16,
    token: String,
    boot_error: Option<String>,
}

/// Use the default port when it is free, otherwise let the OS choose one.
fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        return DEFAULT_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

/// 256 random bits from the operating system, as hex.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("could not generate a random value: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

const KEYRING_SERVICE: &str = "com.personalfinance.app";
const KEYRING_ACCOUNT: &str = "encryption-key";

/// The key that encrypts Plaid access tokens and saved credentials.
///
/// It is kept in the Windows Credential Manager, not in the app's data folder, so copying or
/// backing up the database file alone does not give anyone the tokens. It is created on first run.
/// If the key is ever lost (for example after reinstalling Windows) the saved tokens become
/// unreadable and each institution has to be connected again.
fn encryption_key() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("could not open the Windows Credential Manager: {e}"))?;
    match entry.get_password() {
        Ok(key) if key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(key),
        // Never silently replace a key that exists: that would orphan every saved token.
        Ok(_) => {
            Err("the saved encryption key in the Windows Credential Manager is damaged".to_string())
        }
        Err(keyring::Error::NoEntry) => {
            let key = random_token()?;
            entry
                .set_password(&key)
                .map_err(|e| format!("could not save the encryption key: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("could not read the encryption key: {e}")),
    }
}

/// Where a bundled folder lives: next to the installed app, or (debug builds only) in the repo.
fn resource_path(app: &AppHandle, installed: &str, repo_relative: &str) -> PathBuf {
    let bundled = app
        .path()
        .resource_dir()
        .map(|dir| dir.join(installed))
        .unwrap_or_default();
    if cfg!(debug_assertions) && !bundled.exists() {
        return Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(repo_relative);
    }
    bundled
}

/// Appends a line to the backend log. Only the backend's own output goes here, and the backend
/// never writes tokens or transaction data to it.
fn log_line(file: &mut Option<File>, line: &str) {
    if let Some(f) = file {
        let _ = writeln!(f, "{line}");
    }
}

fn open_backend_log(app: &AppHandle) -> Option<File> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    // Start fresh each launch so the file cannot grow without bound.
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dir.join("backend.log"))
        .ok()
}

fn start_backend(
    app: &AppHandle,
    port: u16,
    token: &str,
    encryption_key: &str,
) -> Result<CommandChild, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let (mut events, child) = app
        .shell()
        .sidecar("backend")
        .map_err(|e| format!("backend program not found: {e}"))?
        .env("PF_PORT", port.to_string())
        .env("PF_TOKEN", token)
        .env("PF_ENCRYPTION_KEY", encryption_key)
        .env("PF_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env(
            "PF_NATIVE_DIR",
            resource_path(app, "native", "src-tauri/resources/native")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            "PF_MIGRATIONS_DIR",
            resource_path(app, "migrations", "drizzle/migrations")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            "PF_STATIC_DIR",
            resource_path(app, "frontend", "frontend/dist")
                .to_string_lossy()
                .to_string(),
        )
        .env("PF_PARENT_PID", std::process::id().to_string())
        .env("PF_VERSION", env!("CARGO_PKG_VERSION"))
        .spawn()
        .map_err(|e| format!("could not start the backend: {e}"))?;

    // Drain the backend's output so its pipes never fill up, and keep a copy in a log file.
    let mut log = open_backend_log(app);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    log_line(&mut log, String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(message) => log_line(&mut log, &format!("error: {message}")),
                CommandEvent::Terminated(payload) => {
                    log_line(&mut log, &format!("backend exited: {payload:?}"));
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Decide how the backend is provided and what the UI should be told.
fn launch(app: &AppHandle) -> Bootstrap {
    // Developer shortcut (debug builds only): run the backend yourself with `npm run dev:backend`
    // and set PF_EXTERNAL_BACKEND=1 so hot reload works without rebuilding the sidecar.
    if cfg!(debug_assertions) && std::env::var("PF_EXTERNAL_BACKEND").as_deref() == Ok("1") {
        return Bootstrap {
            port: DEFAULT_PORT,
            token: std::env::var("PF_TOKEN").unwrap_or_else(|_| "dev-token".into()),
            boot_error: None,
        };
    }

    let port = pick_port();
    let token = match random_token() {
        Ok(token) => token,
        Err(error) => {
            return Bootstrap {
                port,
                token: String::new(),
                boot_error: Some(error),
            }
        }
    };

    let key = match encryption_key() {
        Ok(key) => key,
        Err(error) => {
            return Bootstrap {
                port,
                token,
                boot_error: Some(error),
            }
        }
    };

    match start_backend(app, port, &token, &key) {
        Ok(child) => {
            *app.state::<Backend>().0.lock().unwrap() = Some(child);
            Bootstrap {
                port,
                token,
                boot_error: None,
            }
        }
        Err(error) => Bootstrap {
            port,
            token,
            boot_error: Some(error),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch is redirected to the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // Updates: the page asks GitHub for a newer signed release, installs it, and restarts.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let boot = launch(app.handle());

            // The UI reads this to find the backend; a boot error makes it show a clear message.
            let script = format!(
                "window.__PF__ = {};",
                serde_json::json!({
                    "apiBase": format!("http://127.0.0.1:{}", boot.port),
                    "token": boot.token,
                    "bootError": boot.boot_error,
                })
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Personal Finance")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Stop the backend whenever the app exits.
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
