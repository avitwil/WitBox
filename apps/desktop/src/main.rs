//! WitBox desktop client (Windows x64 / Linux x86_64).
//!
//! A thin native shell around the WitBox web UI: full-window WebView, JS⇄native bridge,
//! tray icon, native notifications (`/ws/notify`) and the device-control agent
//! (`/ws/device`) with its on-device permission gate. See docs/CLIENT_CONTRACT.md.

#![cfg_attr(windows, windows_subsystem = "windows")]

mod app;
mod control;
mod dialog;
mod net;
mod notify;
mod pages;
mod platform;
mod screen;
#[cfg(target_os = "linux")]
mod webkit_ext;
#[cfg(windows)]
mod webview2_ext;

use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::Instant,
};

use serde_json::{json, Value};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder},
    window::{Fullscreen, Window, WindowBuilder},
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};
use wry::{NewWindowResponse, PermissionKind, PermissionResponse, WebContext, WebView, WebViewBuilder};

use app::{
    level_rank, lock, normalize_server_url, Config, ControlStatus, Shared, UserEvent, APP_NAME,
    PLATFORM, VERSION,
};
use notify::{Notifier, Target};
use pages::Page;

static ICON_PNG: &[u8] = include_bytes!("../assets/icon-64.png");

// ---------------------------------------------------------------------------------------
// navigation policy

pub enum NavDecision {
    /// Load inside the app.
    Allow,
    /// Hand over to the system browser / mail client.
    External,
    Block,
}

fn same_origin(url: &url::Url, server_url: &str) -> bool {
    url::Url::parse(server_url)
        .map(|s| s.origin() == url.origin())
        .unwrap_or(false)
}

/// Only the configured server origin (and the built-in pages) live inside the WebView.
pub fn nav_decision(url: &str, server_url: &str) -> NavDecision {
    let Ok(u) = url::Url::parse(url) else {
        return NavDecision::Block;
    };
    match u.scheme() {
        "about" | "data" | "blob" => NavDecision::Allow,
        "http" | "https" => {
            if same_origin(&u, server_url) {
                NavDecision::Allow
            } else {
                NavDecision::External
            }
        }
        "mailto" | "tel" => NavDecision::External,
        _ => NavDecision::Block,
    }
}

/// URL reported for pages rendered with `load_html`.
fn is_builtin_page_url(url: &str) -> bool {
    url.is_empty() || url.starts_with("about:") || url.starts_with("data:")
}

// ---------------------------------------------------------------------------------------
// UI state

struct Ui {
    window: Window,
    webview: WebView,
    /// A built-in page (loading / error / settings) is showing instead of the server UI.
    local_page: bool,
    /// Bumped on every `go_home`; a probe result with an older value is ignored.
    nav_gen: u64,
    /// Deep-link path to open once the probe succeeds.
    pending_path: Option<String>,
    fullscreen: bool,
}

struct Tray {
    icon: TrayIcon,
    status: MenuItem,
    stop: MenuItem,
}

struct State {
    shared: Arc<Shared>,
    ui: Option<Ui>,
    tray: Option<Tray>,
    notifier: Option<Notifier>,
    last_active: Option<String>,
}

fn decode_icon() -> (Vec<u8>, u32, u32) {
    let img = image::load_from_memory(ICON_PNG)
        .expect("embedded icon")
        .to_rgba8();
    let (w, h) = img.dimensions();
    (img.into_raw(), w, h)
}

/// The user's Downloads folder (XDG user dir / known folder), else ~/Downloads.
fn downloads_dir() -> Option<PathBuf> {
    dirs::download_dir().or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
}

fn unique_path(dir: &std::path::Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let p = std::path::Path::new(file_name);
    let stem = p.file_stem().unwrap_or(file_name).to_string_lossy().into_owned();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (1..10_000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(candidate)
}

fn create_ui(
    event_loop: &EventLoop<UserEvent>,
    shared: &Arc<Shared>,
    start_hidden: bool,
) -> Result<Ui, String> {
    let (rgba, w, h) = decode_icon();
    let window_icon = tao::window::Icon::from_rgba(rgba, w, h).ok();
    let window = WindowBuilder::new()
        .with_title(APP_NAME)
        .with_inner_size(LogicalSize::new(1180.0, 800.0))
        .with_min_inner_size(LogicalSize::new(360.0, 520.0))
        .with_window_icon(window_icon)
        .with_theme(Some(tao::window::Theme::Dark))
        .with_background_color((11, 11, 12, 255))
        .with_visible(!start_hidden)
        .build(event_loop)
        .map_err(|e| format!("cannot create the window: {e}"))?;

    // Persistent web profile (cookies, localStorage) in the user's data dir. The context
    // must outlive the WebView, which lives until the process exits.
    let profile = app::data_dir().join(if cfg!(windows) { "WebView2" } else { "webkit" });
    let _ = std::fs::create_dir_all(&profile);
    let context: &'static mut WebContext = Box::leak(Box::new(WebContext::new(Some(profile))));

    let server_url = shared.server_url();
    let mut builder = WebViewBuilder::new_with_web_context(context)
        .with_html(pages::render(
            if server_url.is_empty() { Page::Settings } else { Page::Loading },
            &server_url,
        ))
        .with_background_color((11, 11, 12, 255))
        .with_autoplay(true)
        .with_clipboard(true);

    // web → native bridge
    let s = shared.clone();
    builder = builder.with_ipc_handler(move |req| {
        s.send(UserEvent::Ipc(req.body().clone(), req.uri().to_string()));
    });

    // window.open / target=_blank: never open a second in-app window
    let s = shared.clone();
    builder = builder.with_new_window_req_handler(move |url, _features| {
        match nav_decision(&url, &s.server_url()) {
            NavDecision::Allow if url.starts_with("http") => s.send(UserEvent::Navigate(url)),
            NavDecision::External => platform::open_external(&url),
            _ => {}
        }
        NewWindowResponse::Deny
    });

    // Microphone / camera for the server page (voice input). Only the server origin and
    // the built-in pages are ever loaded as top-level documents.
    builder = builder.with_permission_handler(|kind| match kind {
        PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    });

    // Downloads go to the user's Downloads folder, then a notification is shown.
    builder = builder.with_download_started_handler(|_url, path| {
        if let Some(dir) = downloads_dir() {
            let _ = std::fs::create_dir_all(&dir);
            if path.parent() != Some(dir.as_path()) {
                let name = path
                    .file_name()
                    .map(|n| n.to_os_string())
                    .unwrap_or_else(|| "download".into());
                *path = unique_path(&dir, &name);
            }
        }
        true
    });
    let s = shared.clone();
    builder = builder.with_download_completed_handler(move |_url, path, ok| {
        s.send(UserEvent::Downloaded { path, ok });
    });

    // External links → system browser. (WebView2 raises this for the main frame only; on
    // Linux webkit_ext installs a frame-aware policy handler instead.)
    #[cfg(windows)]
    {
        let s = shared.clone();
        builder = builder.with_navigation_handler(move |url| {
            match nav_decision(&url, &s.server_url()) {
                NavDecision::Allow => true,
                NavDecision::External => {
                    platform::open_external(&url);
                    false
                }
                NavDecision::Block => false,
            }
        });
    }

    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or("window has no GTK container")?;
        builder.build_gtk(vbox)
    };
    #[cfg(windows)]
    let webview = builder.build(&window);
    let webview = webview.map_err(|e| {
        if cfg!(windows) {
            format!(
                "Cannot start the Microsoft Edge WebView2 runtime ({e}).\n\n\
                 It ships with Windows 10/11; if it was removed, install the \"WebView2 \
                 Evergreen Runtime\" from Microsoft and start WitBox again."
            )
        } else {
            format!("cannot create the WebKitGTK web view: {e}")
        }
    })?;

    #[cfg(target_os = "linux")]
    webkit_ext::setup(&webview, shared.clone());
    #[cfg(windows)]
    if let Err(e) = webview2_ext::setup(&webview, shared.clone()) {
        log!("webview: optional WebView2 setup failed: {e}");
    }

    Ok(Ui {
        window,
        webview,
        local_page: true,
        nav_gen: 0,
        pending_path: None,
        fullscreen: false,
    })
}

/// libayatana-appindicator / libappindicator is loaded at runtime by the tray crate, which
/// panics if neither exists; check first and run without a tray in that case.
#[cfg(target_os = "linux")]
fn tray_supported() -> bool {
    [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ]
    .iter()
    .any(|name| unsafe { libloading::Library::new(name).is_ok() })
}
#[cfg(windows)]
fn tray_supported() -> bool {
    true
}

impl State {
    fn init_tray(&mut self) {
        if !tray_supported() {
            log!("tray: no appindicator library found; running without a tray icon");
            return;
        }
        let status = MenuItem::with_id("status", APP_NAME, false, None);
        let open = MenuItem::with_id("open", "Open WitBox", true, None);
        let reload = MenuItem::with_id("reload", "Reload", true, None);
        let server = MenuItem::with_id("server", "Change server…", true, None);
        let stop = MenuItem::with_id("stop", "Stop bot control", false, None);
        let quit = MenuItem::with_id("quit", "Quit", true, None);
        let about = MenuItem::with_id("about", app::CREDIT, false, None);
        let menu = Menu::new();
        let has_ui = self.ui.is_some();
        let mut res = menu
            .append(&status)
            .and_then(|_| menu.append(&PredefinedMenuItem::separator()))
            .and_then(|_| menu.append(&open));
        if has_ui {
            res = res
                .and_then(|_| menu.append(&reload))
                .and_then(|_| menu.append(&server));
        }
        res = res
            .and_then(|_| menu.append(&PredefinedMenuItem::separator()))
            .and_then(|_| menu.append(&stop))
            .and_then(|_| menu.append(&PredefinedMenuItem::separator()))
            .and_then(|_| menu.append(&about))
            .and_then(|_| menu.append(&quit));
        if let Err(e) = res {
            log!("tray: cannot build the menu: {e}");
        }

        let (rgba, w, h) = decode_icon();
        let mut builder = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip(APP_NAME)
            .with_menu_on_left_click(false);
        if let Ok(icon) = tray_icon::Icon::from_rgba(rgba, w, h) {
            builder = builder.with_icon(icon);
        }
        #[cfg(target_os = "linux")]
        {
            // appindicator loads the icon from a file; keep it in our own data dir
            builder = builder.with_temp_dir_path(app::data_dir().join("tray"));
            let _ = std::fs::create_dir_all(app::data_dir().join("tray"));
        }
        match builder.build() {
            Ok(icon) => {
                let s = self.shared.clone();
                MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
                    s.send(UserEvent::Menu(e.id.0.clone()));
                }));
                let s = self.shared.clone();
                TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| match e {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => s.send(UserEvent::TrayClick),
                    _ => {}
                }));
                self.tray = Some(Tray { icon, status, stop });
            }
            Err(e) => log!("tray: cannot create the tray icon: {e}"),
        }
    }

    fn notify(&self, title: &str, body: &str, target: Target, urgent: bool) {
        if let Some(n) = &self.notifier {
            n.show(title, body, target, urgent);
        }
    }

    fn show_window(&mut self) {
        match &self.ui {
            Some(ui) => {
                ui.window.set_visible(true);
                ui.window.set_minimized(false);
                ui.window.set_focus();
            }
            // headless agent mode: "open" means the web UI in the browser
            None if self.shared.has_server() => platform::open_external(&self.shared.server_url()),
            None => log!("no server configured; start WitBox without --no-ui once to set it"),
        }
    }

    fn hide_window(&mut self) {
        if let Some(ui) = &self.ui {
            if self.tray.is_some() {
                ui.window.set_visible(false);
            } else {
                // without a tray there would be no way back, so only minimize
                ui.window.set_minimized(true);
            }
        }
    }

    fn show_local(&mut self, page: Page<'_>) {
        let server = self.shared.server_url();
        if let Some(ui) = &mut self.ui {
            ui.local_page = true;
            if let Err(e) = ui.webview.load_html(&pages::render(page, &server)) {
                log!("webview: cannot show built-in page: {e}");
            }
        }
    }

    /// (Re)load the server UI, optionally at a deep-link path such as "/#/bot/<id>".
    /// Shows the loading page, probes the server off-thread, then either navigates or
    /// shows the "Is Tailscale connected?" page.
    fn go_home(&mut self, path: Option<String>) {
        let Some(ui) = &mut self.ui else { return };
        ui.nav_gen += 1;
        ui.pending_path = path;
        let gen = ui.nav_gen;
        if !self.shared.has_server() {
            // first run: nothing to connect to yet, ask for the server address
            self.show_local(Page::Settings);
            return;
        }
        self.show_local(Page::Loading);
        let shared = self.shared.clone();
        let url = shared.server_url();
        std::thread::spawn(move || {
            let res = net::probe(&url);
            shared.send(UserEvent::Probe {
                gen,
                ok: res.is_ok(),
                detail: res.err().unwrap_or_default(),
            });
        });
    }

    /// Turns a notification / deep-link target into a full URL on the server origin.
    fn server_target(&self, path: &str) -> Option<String> {
        let server = self.shared.server_url();
        if server.is_empty() {
            return None;
        }
        if path.starts_with('/') && !path.starts_with("//") {
            return Some(format!("{server}{path}"));
        }
        let u = url::Url::parse(path).ok()?;
        (matches!(u.scheme(), "http" | "https") && same_origin(&u, &server)).then(|| path.to_string())
    }

    fn open_path(&mut self, path: &str) {
        let target = self.server_target(path);
        self.show_window();
        let Some(target) = target else { return };
        let server = self.shared.server_url();
        match &self.ui {
            Some(ui) if ui.local_page => {
                let rel = target.strip_prefix(&server).unwrap_or("/").to_string();
                self.go_home(Some(rel));
            }
            Some(ui) => {
                if let Err(e) = ui.webview.load_url(&target) {
                    log!("webview: cannot open {target}: {e}");
                }
            }
            None => platform::open_external(&target),
        }
    }

    fn eval(&self, js: &str) {
        if let Some(ui) = &self.ui {
            if let Err(e) = ui.webview.evaluate_script(js) {
                log!("webview: evaluate_script failed: {e}");
            }
        }
    }

    fn emit(&self, event: &str, data: Value) {
        if self.ui.as_ref().is_some_and(|ui| !ui.local_page) {
            self.eval(&format!(
                "window.cbNative && window.cbNative.emit({}, {})",
                Value::from(event),
                data
            ));
        }
    }

    fn permissions_json(&self) -> Value {
        json!(lock(&self.shared.cfg).permissions)
    }

    /// JS → native bridge (contract §2) plus the private commands of the built-in pages.
    fn handle_ipc(&mut self, body: &str, page_url: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(body) else {
            log!("bridge: ignoring malformed message");
            return;
        };
        let id = msg["id"].clone();
        let cmd = msg["cmd"].as_str().unwrap_or("").to_string();
        let args = &msg["args"];

        let local = self.ui.as_ref().is_some_and(|ui| ui.local_page) && is_builtin_page_url(page_url);
        let from_server = url::Url::parse(page_url)
            .map(|u| same_origin(&u, &self.shared.server_url()))
            .unwrap_or(false);

        let result: Option<Value> = if !(local || from_server) {
            log!("bridge: rejected {cmd:?} from untrusted page {page_url:?}");
            Some(json!({"error": "forbidden"}))
        } else if cmd == "setPermission" {
            // `None` = the reply is sent later (after a native confirmation)
            self.set_permission_cmd(id.clone(), args)
        } else {
            Some(match cmd.as_str() {
                "getDeviceInfo" => json!({
                    "deviceId": self.shared.device_id(),
                    "name": app::device_name(),
                    "platform": PLATFORM,
                    "appVersion": VERSION,
                    "controlAvailable": self.shared.control_available,
                    // desktop has no separate "enable" step (Android: accessibility service)
                    "controlEnabled": self.shared.control_available,
                }),
                "getPermissions" => self.permissions_json(),
                "openControlSetup" => json!({"ok": true}),
                "startListening" | "speak" => json!({"error": "unsupported"}),
                "stopListening" | "stopSpeaking" => json!({"ok": true}),
                "getServerUrl" => json!({"url": self.shared.server_url()}),
                "changeServer" => {
                    self.show_local(Page::Settings);
                    json!({"ok": true})
                }
                // ---- built-in pages only ----
                "_retry" | "_cancel" if local => {
                    self.go_home(None);
                    json!({"ok": true})
                }
                "_changeServer" if local => {
                    self.show_local(Page::Settings);
                    json!({"ok": true})
                }
                "_saveServer" if local => match normalize_server_url(args["url"].as_str().unwrap_or("")) {
                    Some(url) => {
                        if url != self.shared.server_url() {
                            log!("server URL changed to {url}");
                            // the WebSocket threads notice the new URL and reconnect
                            self.shared.set_server_url(&url);
                        }
                        self.go_home(None);
                        json!({"ok": true})
                    }
                    None => json!({"error": "Please enter a valid http(s) address, e.g. https://my-server.my-tailnet.ts.net"}),
                },
                _ => json!({"error": "unsupported"}),
            })
        };
        if let Some(result) = result {
            self.resolve(&id, &result);
        }
    }

    fn resolve(&self, id: &Value, result: &Value) {
        self.eval(&format!(
            "window.cbNative && window.cbNative.resolve({id}, {result})"
        ));
    }

    /// `setPermission {botId, level, botName?}`. Lowering applies at once; raising
    /// (never→ask, never→always, ask→always) needs a native confirmation first.
    fn set_permission_cmd(&mut self, id: Value, args: &Value) -> Option<Value> {
        let bot = args["botId"].as_str().unwrap_or("").to_string();
        let level = args["level"].as_str().unwrap_or("").to_string();
        if bot.is_empty() {
            return Some(json!({"error": "botId is required"}));
        }
        if !matches!(level.as_str(), "always" | "ask" | "never") {
            return Some(json!({"error": "level must be always, ask or never"}));
        }
        if level_rank(&level) <= level_rank(&self.shared.level(&bot)) {
            self.shared.set_permission(&bot, &level);
            return Some(json!({"ok": true}));
        }
        // Raising must be confirmed natively: the bridge cannot tell the server page from
        // (bot-generated) content framed inside it, so the page alone is not trusted here.
        if lock(&self.shared.raise_denied_until).is_some_and(|t| t > Instant::now()) {
            log!("bridge: raise of {bot:?} to {level} refused (cooldown after a refusal)");
            return Some(json!({"error": "denied"}));
        }
        if self.shared.confirm_busy.swap(true, Ordering::SeqCst) {
            log!("bridge: raise of {bot:?} to {level} refused (another confirmation is open)");
            return Some(json!({"error": "denied"}));
        }
        let name = args["botName"].as_str().unwrap_or("").to_string();
        log!("bridge: asking the user to confirm {bot:?} -> {level}");
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            let allowed = dialog::confirm_raise(&shared, &name, &bot, &level);
            shared.send(UserEvent::RaiseDecided { id, bot_id: bot, level, allowed });
        });
        None
    }

    fn on_control_status(&mut self, st: ControlStatus) {
        let label = match &st.active {
            Some(bot) => format!("{bot} is controlling this device"),
            None => APP_NAME.to_string(),
        };
        if let Some(tray) = &self.tray {
            tray.status.set_text(&label);
            tray.stop.set_enabled(st.stoppable);
            let tip = match &st.active {
                Some(_) => format!("{APP_NAME} — {label}"),
                None => APP_NAME.to_string(),
            };
            let _ = tray.icon.set_tooltip(Some(tip));
        }
        if st.active != self.last_active {
            if let Some(bot) = &st.active {
                let how = if self.tray.is_some() {
                    "Use “Stop bot control” in the tray menu to revoke access."
                } else {
                    "Set the bot to “never” in WitBox to revoke access."
                };
                self.notify(&format!("{bot} is controlling this device"), how, Target::Show, true);
            }
            self.last_active = st.active;
        }
    }

    fn on_event(&mut self, ev: UserEvent, control_flow: &mut ControlFlow) {
        match ev {
            UserEvent::Ipc(body, url) => self.handle_ipc(&body, &url),
            UserEvent::ShowWindow | UserEvent::TrayClick => self.show_window(),
            UserEvent::OpenPath(path) => self.open_path(&path),
            UserEvent::Navigate(url) => {
                if let Some(ui) = &self.ui {
                    if !ui.local_page && matches!(nav_decision(&url, &self.shared.server_url()), NavDecision::Allow) {
                        let _ = ui.webview.load_url(&url);
                    }
                }
            }
            UserEvent::Notify { title, body, path, urgent } => {
                let target = path.map(Target::Path).unwrap_or(Target::Show);
                self.notify(&title, &body, target, urgent);
            }
            UserEvent::Prompt { prompt, reply } => {
                #[cfg(target_os = "linux")]
                dialog::show_gtk(prompt, reply);
                #[cfg(not(target_os = "linux"))]
                {
                    // Windows shows its dialogs on the worker thread and never sends this
                    drop((prompt, reply));
                }
            }
            UserEvent::RaiseDecided { id, bot_id, level, allowed } => {
                self.shared.confirm_busy.store(false, Ordering::SeqCst);
                log!("bridge: raise of {bot_id:?} to {level}: {}", if allowed { "confirmed" } else { "refused" });
                if allowed {
                    self.shared.set_permission(&bot_id, &level);
                    self.resolve(&id, &json!({"ok": true}));
                    self.emit("permissionsChanged", self.permissions_json());
                } else {
                    *lock(&self.shared.raise_denied_until) = Some(Instant::now() + app::RAISE_COOLDOWN);
                    self.resolve(&id, &json!({"error": "denied"}));
                }
            }
            UserEvent::ControlStatus(st) => self.on_control_status(st),
            UserEvent::PermissionsChanged => self.emit("permissionsChanged", self.permissions_json()),
            UserEvent::Probe { gen, ok, detail } => {
                let server = self.shared.server_url();
                let Some(ui) = &mut self.ui else { return };
                if gen != ui.nav_gen {
                    return; // superseded by a newer navigation
                }
                if ok {
                    let path = ui.pending_path.take().unwrap_or_else(|| "/".to_string());
                    ui.local_page = false;
                    if let Err(e) = ui.webview.load_url(&format!("{server}{path}")) {
                        log!("webview: load_url failed: {e}");
                    }
                } else {
                    log!("server unreachable: {detail}");
                    self.show_local(Page::Error(&detail));
                }
            }
            UserEvent::LoadFailed(detail) => {
                if self.ui.as_ref().is_some_and(|ui| !ui.local_page) {
                    self.show_local(Page::Error(&detail));
                }
            }
            UserEvent::Fullscreen(on) => {
                if let Some(ui) = &mut self.ui {
                    if ui.fullscreen != on {
                        ui.fullscreen = on;
                        ui.window
                            .set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                    }
                }
            }
            UserEvent::Downloaded { path, ok } => {
                let name = path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "file".to_string());
                if ok {
                    let target = path
                        .as_ref()
                        .and_then(|p| p.parent())
                        .map(|d| Target::Folder(d.to_path_buf()))
                        .unwrap_or(Target::Show);
                    self.notify("Download complete", &format!("{name} saved to Downloads"), target, false);
                } else {
                    self.notify("Download failed", &name, Target::Show, false);
                }
            }
            UserEvent::Menu(id) => match id.as_str() {
                "open" => self.show_window(),
                "reload" => {
                    self.show_window();
                    self.go_home(None);
                }
                "server" => {
                    self.show_window();
                    self.show_local(Page::Settings);
                }
                "stop" => self.shared.stop_control(),
                "quit" => {
                    log!("quit requested");
                    self.tray = None; // removes the tray icon
                    *control_flow = ControlFlow::Exit;
                }
                _ => {}
            },
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|a| a == flag);
    if has("--version") || has("-V") {
        println!("{APP_NAME} {VERSION} ({PLATFORM})");
        return;
    }
    if has("--help") || has("-h") {
        println!(
            "{APP_NAME} {VERSION}\n\nUsage: witbox [--hidden] [--no-ui]\n\n  \
             --hidden   start minimized to the tray\n  \
             --no-ui    agent only: tray, notifications and device control, no window\n  \
             --version  print the version"
        );
        return;
    }
    let no_ui = has("--no-ui");
    let start_hidden = has("--hidden");

    app::init_log();
    log!("{APP_NAME} {VERSION} ({PLATFORM}) starting");

    // WebKitGTK's DMA-BUF renderer shows a blank window with the proprietary NVIDIA driver;
    // use the (slightly slower) fallback there unless the user decided otherwise.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let proxy = std::sync::Mutex::new(proxy.clone());
        let first = platform::single_instance(move || {
            let _ = lock(&proxy).send_event(UserEvent::ShowWindow);
        });
        if !first {
            log!("another instance is already running; asked it to show its window");
            return;
        }
    }

    let cfg = Config::load();
    let control_available = screen::available();
    log!(
        "server {} · device {} · control available: {control_available}",
        if cfg.server_url.is_empty() { "(not configured)" } else { &cfg.server_url },
        cfg.device_id
    );
    let shared = Shared::new(cfg, proxy, control_available);

    let ui = if no_ui {
        None
    } else {
        match create_ui(&event_loop, &shared, start_hidden) {
            Ok(ui) => Some(ui),
            Err(e) => platform::fatal(&e),
        }
    };

    net::spawn_notify(shared.clone());
    net::spawn_device(shared.clone());

    let mut state = State {
        shared,
        ui,
        tray: None,
        notifier: None,
        last_active: None,
    };

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                state.init_tray();
                let notifier = Notifier::new(state.shared.clone());
                #[cfg(windows)]
                if let Some(tray) = &state.tray {
                    notifier.attach_tray(tray.icon.window_handle() as isize);
                }
                state.notifier = Some(notifier);
                state.go_home(None);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => state.hide_window(),
            Event::UserEvent(ev) => state.on_event(ev, control_flow),
            _ => {}
        }
    });
}
