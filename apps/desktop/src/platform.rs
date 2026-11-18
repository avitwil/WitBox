//! Small OS helpers: single instance, opening URLs in the system browser, fatal errors.

/// Returns `false` if another instance is already running (it has been asked to show its
/// window). Otherwise installs a listener that calls `on_activate` whenever a later
/// instance starts.
pub fn single_instance(on_activate: impl Fn() + Send + 'static) -> bool {
    imp::single_instance(on_activate)
}

/// Opens http(s) / mailto / tel links with the system default handler.
pub fn open_external(url: &str) {
    let ok = ["http://", "https://", "mailto:", "tel:"]
        .iter()
        .any(|p| url.len() > p.len() && url[..p.len()].eq_ignore_ascii_case(p));
    if !ok {
        crate::log!("refusing to open external url {url:?}");
        return;
    }
    imp::open_external(url);
}

/// Opens a local folder / file with the system file manager.
pub fn open_path(path: &std::path::Path) {
    imp::open_path(path);
}

pub fn fatal(message: &str) -> ! {
    crate::log!("fatal: {message}");
    imp::error_box(message);
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
mod imp {
    use std::{
        io::{Read, Write},
        os::unix::net::{UnixListener, UnixStream},
        path::PathBuf,
        process::{Command, Stdio},
    };

    fn socket_path() -> PathBuf {
        let overridden = std::env::var_os("WITBOX_CONFIG_DIR").is_some_and(|v| !v.is_empty());
        match std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
            Some(dir) if !overridden => PathBuf::from(dir).join("witbox.sock"),
            _ => crate::app::config_dir().join("instance.sock"),
        }
    }

    /// Unix socket paths are limited to ~107 bytes; for longer ones fall back to an
    /// abstract-namespace socket named after a hash of the path.
    fn abstract_addr(path: &std::path::Path) -> Option<std::os::unix::net::SocketAddr> {
        use std::hash::{Hash, Hasher};
        use std::os::linux::net::SocketAddrExt;
        if path.as_os_str().len() <= 100 {
            return None;
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut h);
        let name = format!("witbox-{:016x}", h.finish());
        std::os::unix::net::SocketAddr::from_abstract_name(name).ok()
    }

    pub fn single_instance(on_activate: impl Fn() + Send + 'static) -> bool {
        let path = socket_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let abstract_addr = abstract_addr(&path);
        let existing = match &abstract_addr {
            Some(addr) => UnixStream::connect_addr(addr),
            None => UnixStream::connect(&path),
        };
        if let Ok(mut s) = existing {
            let _ = s.write_all(b"show\n");
            return false;
        }
        let listener = match &abstract_addr {
            Some(addr) => UnixListener::bind_addr(addr),
            None => {
                // nobody listening: a stale socket file may be left over from a crash
                let _ = std::fs::remove_file(&path);
                UnixListener::bind(&path)
            }
        };
        match listener {
            Ok(listener) => {
                std::thread::Builder::new()
                    .name("single-instance".into())
                    .spawn(move || {
                        for mut conn in listener.incoming().flatten() {
                            let mut buf = [0u8; 16];
                            let _ = conn.read(&mut buf);
                            on_activate();
                        }
                    })
                    .ok();
            }
            Err(e) => crate::log!("single-instance: cannot bind {}: {e}", path.display()),
        }
        true
    }

    fn spawn_detached(program: &str, arg: &std::ffi::OsStr) {
        let child = Command::new(program)
            .arg(arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match child {
            // reap it so no zombie is left behind
            Ok(mut c) => {
                std::thread::spawn(move || {
                    let _ = c.wait();
                });
            }
            Err(e) => crate::log!("cannot run {program}: {e}"),
        }
    }

    pub fn open_external(url: &str) {
        spawn_detached("xdg-open", url.as_ref());
    }

    pub fn open_path(path: &std::path::Path) {
        spawn_detached("xdg-open", path.as_os_str());
    }

    pub fn error_box(message: &str) {
        use gtk::prelude::*;
        if gtk::init().is_ok() {
            let d = gtk::MessageDialog::new(
                None::<&gtk::Window>,
                gtk::DialogFlags::MODAL,
                gtk::MessageType::Error,
                gtk::ButtonsType::Close,
                message,
            );
            d.set_title("WitBox");
            d.run();
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows::{
        core::{w, HSTRING},
        Win32::{
            Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0},
            System::Threading::{
                CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject, INFINITE,
            },
            UI::{
                Shell::ShellExecuteW,
                WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, SW_SHOWNORMAL},
            },
        },
    };

    pub fn single_instance(on_activate: impl Fn() + Send + 'static) -> bool {
        unsafe {
            // Both objects live in the session namespace; they are intentionally never
            // closed (they must exist for the lifetime of the process).
            let mutex = CreateMutexW(None, false, w!("Local\\net.witbox.app.instance"));
            let already = GetLastError() == ERROR_ALREADY_EXISTS;
            let event = CreateEventW(None, false, false, w!("Local\\net.witbox.app.activate"));
            if mutex.is_ok() && already {
                if let Ok(ev) = event {
                    let _ = SetEvent(ev);
                }
                return false;
            }
            if let Ok(ev) = event {
                let raw = ev.0 as isize;
                std::thread::Builder::new()
                    .name("single-instance".into())
                    .spawn(move || loop {
                        let ev = HANDLE(raw as *mut core::ffi::c_void);
                        if WaitForSingleObject(ev, INFINITE) != WAIT_OBJECT_0 {
                            break;
                        }
                        on_activate();
                    })
                    .ok();
            }
            true
        }
    }

    fn shell_open(target: &HSTRING) {
        unsafe {
            ShellExecuteW(None, w!("open"), target, None, None, SW_SHOWNORMAL);
        }
    }

    pub fn open_external(url: &str) {
        shell_open(&HSTRING::from(url));
    }

    pub fn open_path(path: &std::path::Path) {
        shell_open(&HSTRING::from(path.as_os_str()));
    }

    pub fn error_box(message: &str) {
        unsafe {
            MessageBoxW(None, &HSTRING::from(message), w!("WitBox"), MB_OK | MB_ICONERROR);
        }
    }
}
