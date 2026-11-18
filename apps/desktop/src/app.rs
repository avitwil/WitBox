//! Shared state, configuration and the event type that crosses threads.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tao::event_loop::EventLoopProxy;

pub const APP_NAME: &str = "WitBox";
#[allow(dead_code)]
pub const APP_ID: &str = "net.witbox.app";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Credit line shown on the built-in pages and in the tray menu.
pub const CREDIT: &str = concat!("WitBox ", env!("CARGO_PKG_VERSION"), " · Created by Avi Twil");
/// Placeholder shown in the "server address" screen. There is no built-in server: WitBox
/// runs on the user's own machine, so the address is asked for on first run.
pub const SERVER_URL_EXAMPLE: &str = "https://my-server.my-tailnet.ts.net";
pub const PLATFORM: &str = if cfg!(windows) { "windows" } else { "linux" };

/// "Allow once" grant length.
pub const GRANT_WINDOW: Duration = Duration::from_secs(5 * 60);
/// How long the permission dialog waits before it counts as "denied".
pub const ASK_TIMEOUT: Duration = Duration::from_secs(60);
/// After a Deny / timeout, further requests of that bot are denied silently for this long
/// (so a bot retrying in a loop cannot spam dialogs).
pub const DENY_COOLDOWN: Duration = Duration::from_secs(15);
/// After a refused permission raise, further raise requests are refused silently for this
/// long (so framed content cannot spam confirmation dialogs).
pub const RAISE_COOLDOWN: Duration = Duration::from_secs(5);
/// The "is controlling this device" indicator stays up this long after the last action.
pub const ACTIVE_IDLE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    AllowOnce,
    Always,
    Deny,
}

/// Events delivered to the UI (main) thread.
#[derive(Debug)]
pub enum UserEvent {
    /// Message from the page: (json body, url of the page that sent it)
    Ipc(String, String),
    /// Show + focus the main window (tray "Open", second instance started, ...).
    ShowWindow,
    /// Show the window at SERVER_URL + path (notification tapped). `path` like "/#/bot/x".
    OpenPath(String),
    /// Show an OS notification; `path` (optional) is opened when it is clicked.
    Notify {
        title: String,
        body: String,
        path: Option<String>,
        urgent: bool,
    },
    /// Show a native modal prompt on the UI thread (Linux; Windows runs its dialogs on the
    /// calling worker thread). The pressed button id goes to `reply`.
    #[cfg_attr(windows, allow(dead_code))]
    Prompt {
        prompt: crate::dialog::Prompt,
        reply: mpsc::Sender<i32>,
    },
    /// The user answered the confirmation for a `setPermission` raise (bridge call `id`).
    RaiseDecided {
        id: serde_json::Value,
        bot_id: String,
        level: String,
        allowed: bool,
    },
    /// Remote-control indicator changed.
    ControlStatus(ControlStatus),
    /// Permissions were changed natively (dialog / Stop) – tell the page.
    PermissionsChanged,
    /// Result of the reachability probe started by `go_home`.
    Probe { gen: u64, ok: bool, detail: String },
    /// The main-frame navigation failed with a network error.
    LoadFailed(String),
    /// The page entered / left HTML fullscreen (Windows; WebKitGTK handles it itself).
    #[cfg_attr(not(windows), allow(dead_code))]
    Fullscreen(bool),
    /// A download finished.
    Downloaded { path: Option<PathBuf>, ok: bool },
    /// Load a same-origin URL in the main view (window.open / target=_blank).
    Navigate(String),
    /// Tray / menu.
    Menu(String),
    TrayClick,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ControlStatus {
    /// Name of the bot currently controlling the device.
    pub active: Option<String>,
    /// True if "Stop bot control" would do something (active bot or a live grant window).
    pub stoppable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server_url: String,
    pub device_id: String,
    /// botId -> "always" | "ask" | "never"
    pub permissions: BTreeMap<String, String>,
    /// Windows only: "auto" (toast, tray balloon if toasts fail / are disabled),
    /// "toast" or "balloon". Not written unless set by hand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_mode: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            // empty = not configured yet; the app opens the "server address" screen
            server_url: String::new(),
            device_id: String::new(),
            permissions: BTreeMap::new(),
            notify_mode: None,
        }
    }
}

/// %APPDATA%\WitBox on Windows, ~/.config/witbox on Linux.
/// `WITBOX_CONFIG_DIR` overrides it (used for tests / portable setups).
pub fn config_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("WITBOX_CONFIG_DIR").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let base = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    base.join(if cfg!(windows) { "WitBox" } else { "witbox" })
}

/// Web profile (cookies, localStorage), icon cache, log file.
/// %LOCALAPPDATA%\WitBox on Windows, ~/.local/share/witbox on Linux.
pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("WITBOX_DATA_DIR").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(p) = std::env::var_os("WITBOX_CONFIG_DIR").filter(|p| !p.is_empty()) {
        return PathBuf::from(p).join("data");
    }
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.join(if cfg!(windows) { "WitBox" } else { "witbox" })
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Accepts "host", "host:port", "http(s)://host[:port][/base]"; returns a normalized URL
/// without a trailing slash, or None if it is not a usable http(s) URL.
pub fn normalize_server_url(input: &str) -> Option<String> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let s = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let u = url::Url::parse(&s).ok()?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return None;
    }
    let mut out = format!("{}://{}", u.scheme(), u.host_str()?);
    if let Some(p) = u.port() {
        out.push_str(&format!(":{p}"));
    }
    out.push_str(u.path().trim_end_matches('/'));
    Some(out)
}

impl Config {
    pub fn load() -> Self {
        let path = config_path();
        let mut cfg: Config = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut dirty = !path.exists();
        if uuid::Uuid::parse_str(&cfg.device_id).is_err() {
            cfg.device_id = uuid::Uuid::new_v4().to_string();
            dirty = true;
        }
        match normalize_server_url(&cfg.server_url) {
            Some(u) if u == cfg.server_url => {}
            Some(u) => {
                cfg.server_url = u;
                dirty = true;
            }
            None => {
                // not configured (or unusable): ask for it on start
                dirty |= !cfg.server_url.is_empty();
                cfg.server_url.clear();
            }
        }
        let before = cfg.permissions.len();
        cfg.permissions
            .retain(|_, v| matches!(v.as_str(), "always" | "ask" | "never"));
        dirty |= before != cfg.permissions.len();
        if dirty {
            cfg.save();
        }
        cfg
    }

    pub fn save(&self) {
        let path = config_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        let data = serde_json::to_string_pretty(self).unwrap_or_default();
        let res = std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, &path));
        if let Err(e) = res {
            crate::log!("config: cannot save {}: {e}", path.display());
        }
    }
}

/// never < ask < always. Unknown values rank as `never`.
pub fn level_rank(level: &str) -> u8 {
    match level {
        "always" => 2,
        "ask" => 1,
        _ => 0,
    }
}

pub struct Active {
    pub bot_id: String,
    pub bot_name: String,
    pub last: Instant,
}

pub struct Shared {
    pub cfg: Mutex<Config>,
    proxy: Mutex<EventLoopProxy<UserEvent>>,
    /// This machine/session can be remote-controlled (false on Wayland sessions).
    pub control_available: bool,
    /// "Allow once" windows: botId -> expiry.
    pub grants: Mutex<HashMap<String, Instant>>,
    pub denied_until: Mutex<HashMap<String, Instant>>,
    pub active: Mutex<Option<Active>>,
    /// A `setPermission` raise confirmation dialog is open (only one at a time).
    pub confirm_busy: std::sync::atomic::AtomicBool,
    /// After a refused raise, further raise requests are refused silently until then.
    pub raise_denied_until: Mutex<Option<Instant>>,
    last_status: Mutex<ControlStatus>,
}

pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn new(cfg: Config, proxy: EventLoopProxy<UserEvent>, control_available: bool) -> Arc<Self> {
        Arc::new(Self {
            cfg: Mutex::new(cfg),
            proxy: Mutex::new(proxy),
            control_available,
            grants: Mutex::new(HashMap::new()),
            denied_until: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            confirm_busy: std::sync::atomic::AtomicBool::new(false),
            raise_denied_until: Mutex::new(None),
            last_status: Mutex::new(ControlStatus::default()),
        })
    }

    pub fn send(&self, ev: UserEvent) {
        let _ = lock(&self.proxy).send_event(ev);
    }

    pub fn server_url(&self) -> String {
        lock(&self.cfg).server_url.clone()
    }

    /// False until the user has entered a server address.
    pub fn has_server(&self) -> bool {
        !lock(&self.cfg).server_url.is_empty()
    }

    pub fn device_id(&self) -> String {
        lock(&self.cfg).device_id.clone()
    }

    /// Permission level of a bot; missing ⇒ "never".
    /// NOTE: `set_permission` applies unconditionally. Callers acting on behalf of the web
    /// page must get a native confirmation first when the change raises the level.
    pub fn level(&self, bot_id: &str) -> String {
        lock(&self.cfg)
            .permissions
            .get(bot_id)
            .cloned()
            .unwrap_or_else(|| "never".to_string())
    }

    pub fn set_permission(&self, bot_id: &str, level: &str) {
        let mut cfg = lock(&self.cfg);
        cfg.permissions.insert(bot_id.to_string(), level.to_string());
        cfg.save();
        drop(cfg);
        if level != "ask" {
            // a pending "allow once" window is meaningless for always / never
            lock(&self.grants).remove(bot_id);
        }
        if level == "never" {
            let mut active = lock(&self.active);
            if active.as_ref().is_some_and(|a| a.bot_id == bot_id) {
                *active = None;
            }
        }
        lock(&self.denied_until).remove(bot_id);
        self.refresh_status();
    }

    pub fn set_server_url(&self, url: &str) {
        let mut cfg = lock(&self.cfg);
        cfg.server_url = url.to_string();
        cfg.save();
    }

    /// `wss://host/ws/<channel>?deviceId=..&name=..&platform=..`
    pub fn ws_url(&self, channel: &str) -> String {
        let base = self.server_url();
        let ws_base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            base
        };
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("deviceId", &self.device_id())
            .append_pair("name", &device_name())
            .append_pair("platform", PLATFORM)
            .finish();
        format!("{ws_base}/ws/{channel}?{query}")
    }

    /// Recompute the control indicator and notify the UI thread if it changed.
    pub fn refresh_status(&self) {
        let now = Instant::now();
        let active = {
            let mut a = lock(&self.active);
            if a.as_ref().is_some_and(|a| now.duration_since(a.last) > ACTIVE_IDLE) {
                *a = None;
            }
            a.as_ref().map(|a| a.bot_name.clone())
        };
        let live_grant = {
            let mut g = lock(&self.grants);
            g.retain(|_, exp| *exp > now);
            !g.is_empty()
        };
        let status = ControlStatus {
            stoppable: active.is_some() || live_grant,
            active,
        };
        let mut last = lock(&self.last_status);
        if *last != status {
            *last = status.clone();
            drop(last);
            self.send(UserEvent::ControlStatus(status));
        }
    }

    /// "Stop bot control": revoke every live grant window and put the controlling bot back
    /// to `ask`. This only ever LOWERS a level (always → ask); it never raises one.
    pub fn stop_control(&self) {
        let mut bots: Vec<String> = lock(&self.grants).drain().map(|(k, _)| k).collect();
        if let Some(a) = lock(&self.active).take() {
            bots.push(a.bot_id);
        }
        bots.sort();
        bots.dedup();
        {
            let mut cfg = lock(&self.cfg);
            for b in &bots {
                if cfg.permissions.get(b).is_some_and(|l| l == "always") {
                    cfg.permissions.insert(b.clone(), "ask".to_string());
                }
            }
            cfg.save();
        }
        crate::log!("control: stopped by user ({} bot(s) set to ask)", bots.len());
        self.refresh_status();
        self.send(UserEvent::PermissionsChanged);
    }
}

/// Host / computer name.
pub fn device_name() -> String {
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(windows))]
    let name = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(|| std::env::var("HOSTNAME").ok());
    let name = name.map(|s| s.trim().to_string()).unwrap_or_default();
    if name.is_empty() {
        format!("{PLATFORM}-device")
    } else {
        name
    }
}

// ---------------------------------------------------------------------------------------
// logging: stderr + <data dir>/witbox.log (the Windows build has no console)

static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn init_log() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("witbox.log");
    let too_big = std::fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!too_big)
        .truncate(too_big)
        .open(&path)
        .ok();
    *lock(&LOG_FILE) = file;
}

pub fn log_line(msg: std::fmt::Arguments<'_>) {
    use std::io::Write;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{secs}] {msg}\n");
    let _ = std::io::stderr().write_all(line.as_bytes());
    if let Some(f) = lock(&LOG_FILE).as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::app::log_line(format_args!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_built_in_server() {
        // a fresh install must ask for the server address instead of shipping one
        assert!(Config::default().server_url.is_empty());
        assert_eq!(normalize_server_url(""), None);
        assert_eq!(
            normalize_server_url("my-server.my-tailnet.ts.net/").as_deref(),
            Some("https://my-server.my-tailnet.ts.net")
        );
        assert_eq!(normalize_server_url(SERVER_URL_EXAMPLE).as_deref(), Some(SERVER_URL_EXAMPLE));
    }
}
