//! Native notifications.
//!
//! * Linux: `org.freedesktop.Notifications` over the session bus through gio (already
//!   linked via GTK, so no extra dependency). Clicking a notification opens its target.
//! * Windows: WinRT toast under the app's own AppUserModelID (registered in HKCU on start
//!   so the toast shows "WitBox" and its icon without an installer / shortcut).

use std::sync::Arc;

use crate::app::{Shared, UserEvent, APP_NAME};

/// What a click on a notification does.
#[derive(Clone, Debug)]
pub enum Target {
    /// Show the app at SERVER_URL + path.
    Path(String),
    /// Just bring the window up.
    Show,
    /// Open a local file's folder (finished download).
    Folder(std::path::PathBuf),
}

fn activate(shared: &Shared, target: &Target) {
    match target {
        Target::Path(p) => shared.send(UserEvent::OpenPath(p.clone())),
        Target::Show => shared.send(UserEvent::ShowWindow),
        Target::Folder(p) => crate::platform::open_path(p),
    }
}

/// Writes the embedded icon next to the profile so the notification services can load it.
fn icon_file() -> Option<std::path::PathBuf> {
    static ICON: &[u8] = include_bytes!("../assets/icon-256.png");
    let dir = crate::app::data_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("icon.png");
    let current = std::fs::read(&path).map(|b| b == ICON).unwrap_or(false);
    if !current {
        std::fs::write(&path, ICON).ok()?;
    }
    Some(path)
}

#[cfg(target_os = "linux")]
pub use linux::Notifier;
#[cfg(windows)]
pub use win::Notifier;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::{gio, glib, glib::prelude::*};
    use std::{cell::RefCell, collections::HashMap, rc::Rc};

    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// UI-thread only.
    pub struct Notifier {
        conn: Option<gio::DBusConnection>,
        targets: Rc<RefCell<HashMap<u32, Target>>>,
        icon: String,
    }

    impl Notifier {
        pub fn new(shared: Arc<Shared>) -> Self {
            let targets: Rc<RefCell<HashMap<u32, Target>>> = Rc::default();
            let conn = match gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
                Ok(c) => Some(c),
                Err(e) => {
                    crate::log!("notify: no session bus, notifications disabled ({e})");
                    None
                }
            };
            if let Some(conn) = &conn {
                let t = targets.clone();
                conn.signal_subscribe(
                    Some(NAME),
                    Some(NAME),
                    Some("ActionInvoked"),
                    Some(PATH),
                    None,
                    gio::DBusSignalFlags::NONE,
                    move |_, _, _, _, _, params| {
                        if let Some((id, _action)) = params.get::<(u32, String)>() {
                            if let Some(target) = t.borrow_mut().remove(&id) {
                                activate(&shared, &target);
                            }
                        }
                    },
                );
                let t = targets.clone();
                conn.signal_subscribe(
                    Some(NAME),
                    Some(NAME),
                    Some("NotificationClosed"),
                    Some(PATH),
                    None,
                    gio::DBusSignalFlags::NONE,
                    move |_, _, _, _, _, params| {
                        if let Some((id, _reason)) = params.get::<(u32, u32)>() {
                            // ActionInvoked arrives before NotificationClosed, so the click
                            // has already been handled when the entry is dropped here.
                            let t = t.clone();
                            glib::idle_add_local_once(move || {
                                t.borrow_mut().remove(&id);
                            });
                        }
                    },
                );
            }
            Self {
                conn,
                targets,
                icon: icon_file()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            }
        }

        pub fn show(&self, title: &str, body: &str, target: Target, urgent: bool) {
            let Some(conn) = &self.conn else {
                crate::log!("notify: FAILED for {title:?}: no session bus");
                return;
            };
            let mut hints: HashMap<String, glib::Variant> = HashMap::new();
            hints.insert("urgency".into(), (if urgent { 2u8 } else { 1u8 }).to_variant());
            hints.insert("desktop-entry".into(), "witbox".to_variant());
            let actions: Vec<String> = vec!["default".into(), "Open".into()];
            // Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, timeout)
            let args = (
                APP_NAME,
                0u32,
                self.icon.as_str(),
                title,
                glib::markup_escape_text(body).as_str(),
                actions,
                hints,
                -1i32,
            )
                .to_variant();
            let targets = self.targets.clone();
            let summary = title.to_string();
            conn.call(
                Some(NAME),
                PATH,
                NAME,
                "Notify",
                Some(&args),
                Some(glib::VariantTy::new("(u)").unwrap()),
                gio::DBusCallFlags::NONE,
                5000,
                gio::Cancellable::NONE,
                move |res| match res {
                    Ok(v) => {
                        if let Some((id,)) = v.get::<(u32,)>() {
                            let mut t = targets.borrow_mut();
                            if t.len() > 200 {
                                t.clear();
                            }
                            t.insert(id, target);
                            crate::log!("notify: notification {id} sent: {summary:?}");
                        }
                    }
                    Err(e) => crate::log!("notify: FAILED for {summary:?}: {e}"),
                },
            );
        }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::app::{lock, APP_ID};
    use std::{cell::Cell, sync::Mutex};
    use tauri_winrt_notification::{Duration, Toast};
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, WPARAM},
            UI::{
                Shell::{
                    DefSubclassProc, SHQueryUserNotificationState, SetWindowSubclass,
                    Shell_NotifyIconW, NIF_INFO, NIIF_INFO, NIM_MODIFY, NOTIFYICONDATAW,
                    QUNS_ACCEPTS_NOTIFICATIONS,
                },
                WindowsAndMessaging::WM_USER,
            },
        },
        UI::Notifications::{NotificationSetting, ToastNotificationManager},
    };

    /// tray-icon's private callback message for its notify icon.
    const WM_TRAYICON: u32 = 6002;
    const NIN_BALLOONUSERCLICK: u32 = WM_USER + 5;

    /// What a click on the most recent tray balloon opens.
    static BALLOON_TARGET: Mutex<Option<(Arc<Shared>, Target)>> = Mutex::new(None);

    pub struct Notifier {
        shared: Arc<Shared>,
        /// Window owning the tray icon (for the balloon fallback).
        tray_hwnd: Cell<Option<isize>>,
        /// "auto" | "toast" | "balloon" (config `notifyMode`).
        mode: String,
    }

    /// Sees the tray icon's callback messages before tray-icon does, to catch balloon clicks.
    unsafe extern "system" fn tray_subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_TRAYICON && (lparam.0 as u32 & 0xFFFF) == NIN_BALLOONUSERCLICK {
            if let Some((shared, target)) = lock(&BALLOON_TARGET).take() {
                activate(&shared, &target);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    fn copy_wide(dst: &mut [u16], text: &str) {
        let max = dst.len() - 1;
        let mut n = 0;
        for unit in text.encode_utf16().take(max) {
            dst[n] = unit;
            n += 1;
        }
        // never cut a surrogate pair in half
        if n > 0 && (0xD800..0xDC00).contains(&dst[n - 1]) {
            n -= 1;
        }
        dst[n] = 0;
    }

    impl Notifier {
        pub fn new(shared: Arc<Shared>) -> Self {
            // Register the AppUserModelID so toasts are attributed to "WitBox" (works for
            // unpackaged apps without a Start-menu shortcut on Windows 10/11).
            let register = || -> windows_registry::Result<()> {
                let key = windows_registry::CURRENT_USER
                    .create(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))?;
                key.set_string("DisplayName", APP_NAME)?;
                if let Some(icon) = icon_file() {
                    key.set_string("IconUri", icon.to_string_lossy().as_ref())?;
                }
                key.set_string("IconBackgroundColor", "FF0B0B0C")?;
                Ok(())
            };
            if let Err(e) = register() {
                crate::log!("notify: cannot register AppUserModelID: {e}");
            }
            unsafe {
                let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
                    &HSTRING::from(APP_ID),
                );
            }
            let mode = lock(&shared.cfg)
                .notify_mode
                .clone()
                .filter(|m| matches!(m.as_str(), "toast" | "balloon"))
                .unwrap_or_else(|| "auto".to_string());
            Self {
                shared,
                tray_hwnd: Cell::new(None),
                mode,
            }
        }

        /// Call once the tray icon exists (UI thread).
        pub fn attach_tray(&self, hwnd: isize) {
            self.tray_hwnd.set(Some(hwnd));
            unsafe {
                let ok = SetWindowSubclass(HWND(hwnd as *mut _), Some(tray_subclass), 0xCB01, 0);
                if !ok.as_bool() {
                    crate::log!("notify: cannot hook the tray window (balloon clicks ignored)");
                }
            }
        }

        /// Why Windows would not show a toast for this app right now, if it says so.
        fn toast_blocked() -> Option<String> {
            let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
                .and_then(|n| n.Setting());
            match setting {
                Ok(NotificationSetting::Enabled) => None,
                Ok(NotificationSetting::DisabledForApplication) => Some("disabled for this app".into()),
                Ok(NotificationSetting::DisabledForUser) => Some("notifications are turned off for this user".into()),
                Ok(NotificationSetting::DisabledByGroupPolicy) => Some("disabled by group policy".into()),
                Ok(NotificationSetting::DisabledByManifest) => Some("disabled by manifest".into()),
                Ok(other) => Some(format!("setting {}", other.0)),
                Err(e) => Some(format!("toast notifier unavailable: {e}")),
            }
        }

        /// Shell state hint for the log. Anything but "accepts notifications" means Windows
        /// delivers silently to the notification center (no banner), for toasts and
        /// balloons alike - e.g. Do-not-disturb during the first hour of a new account.
        fn shell_state() -> String {
            match unsafe { SHQueryUserNotificationState() } {
                Ok(QUNS_ACCEPTS_NOTIFICATIONS) => "shell accepts notifications".into(),
                Ok(state) => {
                    let name = match state.0 {
                        1 => "screen locked / screen saver",
                        2 => "a full-screen app is running",
                        3 => "a full-screen Direct3D app is running",
                        4 => "presentation mode",
                        6 => "quiet time / Do not disturb (first hour of a new account)",
                        7 => "a full-screen Store app is running",
                        _ => "unknown",
                    };
                    format!("shell state {}: {name} - Windows shows no banner, the notification goes to the notification center", state.0)
                }
                Err(e) => format!("shell state unknown ({e})"),
            }
        }

        fn toast(&self, title: &str, body: &str, target: &Target) -> Result<(), String> {
            let shared = self.shared.clone();
            let target = target.clone();
            Toast::new(APP_ID)
                .title(title)
                .text1(body)
                .duration(Duration::Short)
                .on_activated(move |_action| {
                    activate(&shared, &target);
                    Ok(())
                })
                .show()
                .map_err(|e| e.to_string())
        }

        /// Classic tray balloon (Windows 10/11 render it as a toast owned by the tray icon).
        fn balloon(&self, title: &str, body: &str, target: &Target) -> Result<(), String> {
            let hwnd = self.tray_hwnd.get().ok_or("no tray icon")?;
            let mut nid = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: HWND(hwnd as *mut _),
                uFlags: NIF_INFO,
                dwInfoFlags: NIIF_INFO,
                ..Default::default()
            };
            copy_wide(&mut nid.szInfoTitle, title);
            // an empty szInfo would remove the balloon instead of showing one
            copy_wide(&mut nid.szInfo, if body.is_empty() { " " } else { body });
            *lock(&BALLOON_TARGET) = Some((self.shared.clone(), target.clone()));
            // tray-icon numbers its icons from a private counter; ours is one of the first
            for uid in 1..=16 {
                nid.uID = uid;
                if unsafe { Shell_NotifyIconW(NIM_MODIFY, &nid) }.as_bool() {
                    return Ok(());
                }
            }
            Err("Shell_NotifyIcon(NIF_INFO) failed".into())
        }

        pub fn show(&self, title: &str, body: &str, target: Target, _urgent: bool) {
            let state = Self::shell_state();
            let blocked = if self.mode == "balloon" {
                Some("notifyMode = balloon".to_string())
            } else {
                Self::toast_blocked()
            };
            let toast_error = match &blocked {
                Some(why) if self.mode != "toast" => why.clone(),
                _ => match self.toast(title, body, &target) {
                    Ok(()) => {
                        crate::log!("notify: toast sent: {title:?} [{state}]");
                        return;
                    }
                    Err(e) => e,
                },
            };
            if self.mode == "toast" {
                crate::log!("notify: toast FAILED for {title:?}: {toast_error} [{state}]");
                return;
            }
            match self.balloon(title, body, &target) {
                Ok(()) => crate::log!(
                    "notify: tray balloon sent: {title:?} (toast not used: {toast_error}) [{state}]"
                ),
                Err(e) => crate::log!(
                    "notify: FAILED for {title:?}: toast: {toast_error}; balloon: {e} [{state}]"
                ),
            }
        }
    }
}
