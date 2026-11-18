//! Native modal prompts with a 60 s timeout:
//!
//! * the device-control gate: "‹bot› wants to control this device"
//!   (Allow once (5 min) / Always allow / Deny), and
//! * the confirmation for a permission *raise* requested through the JS bridge:
//!   "Allow ‹bot› to control this computer: ‹Always / Ask each time›?" (Allow / Cancel).
//!
//! Linux: a GTK message dialog shown on the UI thread (requested through the event loop).
//! Windows: a TaskDialog (Common Controls v6) run on the calling worker thread with its own
//! modal loop; falls back to a plain MessageBox if TaskDialogIndirect is missing.
//!
//! Both functions block the calling thread and must NOT be called on the UI thread.

use std::sync::Arc;

use crate::app::{Decision, Shared};

const TITLE: &str = "WitBox";

/// A prompt: the first button is the affirmative one, the last one the safe default that
/// is also used for Esc / closing the window / the timeout.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub headline: String,
    pub detail: String,
    /// (id, label); ids must be > 0.
    pub buttons: Vec<(i32, &'static str)>,
}

impl Prompt {
    fn default_id(&self) -> i32 {
        self.buttons.last().map(|b| b.0).unwrap_or(0)
    }
}

/// Server/page-supplied names are display-only: one short line, no control characters.
fn clean(name: &str, max: usize) -> String {
    let s: String = name.chars().filter(|c| !c.is_control()).take(max).collect();
    s.trim().to_string()
}

const ID_ONCE: i32 = 101;
const ID_ALWAYS: i32 = 102;
const ID_DENY: i32 = 103;
const ID_ALLOW: i32 = 111;
const ID_CANCEL: i32 = 112;

/// Device-control gate for a bot whose level is `ask`.
pub fn ask(shared: &Arc<Shared>, bot_name: &str) -> Decision {
    let prompt = Prompt {
        headline: format!("{} wants to control this device", clean(bot_name, 60)),
        detail: "If you allow this, the bot can see your screen and use the mouse and \
                 keyboard of this device.\n\nNo answer within 60 seconds counts as Deny."
            .to_string(),
        buttons: vec![
            (ID_ONCE, "Allow once (5 min)"),
            (ID_ALWAYS, "Always allow"),
            (ID_DENY, "Deny"),
        ],
    };
    match run(shared, prompt) {
        ID_ONCE => Decision::AllowOnce,
        ID_ALWAYS => Decision::Always,
        _ => Decision::Deny,
    }
}

/// Confirmation for raising a bot's permission level to `level` ("ask" or "always").
/// Returns true only if the user pressed Allow.
pub fn confirm_raise(shared: &Arc<Shared>, bot_name: &str, bot_id: &str, level: &str) -> bool {
    let (mode, what) = if level == "always" {
        (
            "Always",
            "The bot will be able to see your screen and use the mouse and keyboard of this \
             computer at any time, without asking again.",
        )
    } else {
        (
            "Ask each time",
            "The bot will be able to request control of this computer; you will be asked \
             every time before it can see the screen or use the mouse and keyboard.",
        )
    };
    let name = clean(bot_name, 60);
    let id = clean(bot_id, 80);
    let name = if name.is_empty() { id.clone() } else { name };
    let prompt = Prompt {
        headline: format!("Allow {name} to control this computer: {mode}?"),
        detail: format!(
            "{what}\n\nBot ID: {id}\nThis change was requested from the WitBox page. If you \
             did not ask for it, choose Cancel.\n\nNo answer within 60 seconds counts as Cancel."
        ),
        buttons: vec![(ID_ALLOW, "Allow"), (ID_CANCEL, "Cancel")],
    };
    run(shared, prompt) == ID_ALLOW
}

/// Shows the prompt and returns the id of the pressed button (the default id on
/// Esc / close / timeout).
#[cfg(target_os = "linux")]
fn run(shared: &Arc<Shared>, prompt: Prompt) -> i32 {
    use crate::app::{UserEvent, ASK_TIMEOUT};
    let default = prompt.default_id();
    let (tx, rx) = std::sync::mpsc::channel();
    shared.send(UserEvent::Prompt { prompt, reply: tx });
    // the dialog enforces the 60 s itself; the margin only covers a stuck UI thread
    rx.recv_timeout(ASK_TIMEOUT + std::time::Duration::from_secs(5))
        .unwrap_or(default)
}

#[cfg(windows)]
fn run(_shared: &Arc<Shared>, prompt: Prompt) -> i32 {
    win::run(&prompt)
}

/// Must be called on the GTK main thread.
#[cfg(target_os = "linux")]
pub fn show_gtk(prompt: Prompt, reply: std::sync::mpsc::Sender<i32>) {
    use crate::app::ASK_TIMEOUT;
    use gtk::{glib, prelude::*};
    use std::{cell::Cell, rc::Rc};

    let default = prompt.default_id();
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::empty(),
        gtk::MessageType::Warning,
        gtk::ButtonsType::None,
        &prompt.headline,
    );
    dialog.set_title(TITLE);
    dialog.set_secondary_text(Some(&prompt.detail));
    // GTK convention: safe choice first (left), affirmative last (right)
    for (id, label) in prompt.buttons.iter().rev() {
        dialog.add_button(label, gtk::ResponseType::Other(*id as u16));
    }
    dialog.set_default_response(gtk::ResponseType::Other(default as u16));
    dialog.set_keep_above(true);
    dialog.set_position(gtk::WindowPosition::Center);
    dialog.set_skip_taskbar_hint(false);
    dialog.set_urgency_hint(true);

    let done = Rc::new(Cell::new(false));
    {
        let done = done.clone();
        let reply = reply.clone();
        dialog.connect_response(move |d, resp| {
            if !done.replace(true) {
                let id = match resp {
                    gtk::ResponseType::Other(id) => id as i32,
                    _ => default, // window closed / Esc
                };
                let _ = reply.send(id);
            }
            d.close();
        });
    }
    {
        let dialog = dialog.clone();
        glib::timeout_add_seconds_local(ASK_TIMEOUT.as_secs() as u32, move || {
            if !done.replace(true) {
                let _ = reply.send(default);
                dialog.close();
            }
            glib::ControlFlow::Break
        });
    }
    dialog.show_all();
    dialog.present();
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::app::ASK_TIMEOUT;
    use windows::{
        core::{s, w, BOOL, HRESULT, HSTRING, PCWSTR},
        Win32::{
            Foundation::{HWND, LPARAM, WPARAM},
            System::LibraryLoader::{GetProcAddress, LoadLibraryW},
            UI::{
                Controls::{
                    TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS,
                    TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDF_SIZE_TO_CONTENT,
                    TDM_CLICK_BUTTON, TDN_CREATED, TDN_TIMER, TD_WARNING_ICON,
                },
                WindowsAndMessaging::{
                    FindWindowW, MessageBoxW, PostMessageW, SetForegroundWindow, SetWindowPos,
                    HWND_TOPMOST, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND,
                    MB_TOPMOST, MB_YESNOCANCEL, SWP_NOMOVE, SWP_NOSIZE, WM_CLOSE,
                },
            },
        },
    };

    type TaskDialogIndirectFn = unsafe extern "system" fn(
        *const TASKDIALOGCONFIG,
        *mut i32,
        *mut i32,
        *mut BOOL,
    ) -> HRESULT;

    /// `data` = id of the default (safe) button, clicked when the time is up.
    unsafe extern "system" fn callback(
        hwnd: HWND,
        msg: TASKDIALOG_NOTIFICATIONS,
        wparam: WPARAM,
        _lparam: LPARAM,
        data: isize,
    ) -> HRESULT {
        if msg == TDN_CREATED {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            let _ = SetForegroundWindow(hwnd);
        } else if msg == TDN_TIMER && wparam.0 as u128 >= ASK_TIMEOUT.as_millis() {
            // wparam = milliseconds since the dialog was created → auto-deny
            let _ = PostMessageW(
                Some(hwnd),
                TDM_CLICK_BUTTON.0 as u32,
                WPARAM(data as usize),
                LPARAM(0),
            );
        }
        HRESULT(0)
    }

    /// TaskDialogIndirect only exists in comctl32 v6 (activated by the exe manifest); it is
    /// looked up at runtime so a missing manifest can never prevent the app from starting.
    fn task_dialog_fn() -> Option<TaskDialogIndirectFn> {
        unsafe {
            let module = LoadLibraryW(w!("comctl32.dll")).ok()?;
            let addr = GetProcAddress(module, s!("TaskDialogIndirect"))?;
            Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirectFn>(addr))
        }
    }

    pub fn run(prompt: &Prompt) -> i32 {
        let default = prompt.default_id();
        let headline = HSTRING::from(prompt.headline.as_str());
        let detail = HSTRING::from(prompt.detail.as_str());
        let title = HSTRING::from(TITLE);

        if let Some(task_dialog) = task_dialog_fn() {
            let labels: Vec<HSTRING> = prompt.buttons.iter().map(|b| HSTRING::from(b.1)).collect();
            let buttons: Vec<TASKDIALOG_BUTTON> = prompt
                .buttons
                .iter()
                .zip(&labels)
                .map(|(b, label)| TASKDIALOG_BUTTON {
                    nButtonID: b.0,
                    pszButtonText: PCWSTR(label.as_ptr()),
                })
                .collect();
            let mut config = TASKDIALOGCONFIG {
                cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
                dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER | TDF_SIZE_TO_CONTENT,
                pszWindowTitle: PCWSTR(title.as_ptr()),
                pszMainInstruction: PCWSTR(headline.as_ptr()),
                pszContent: PCWSTR(detail.as_ptr()),
                cButtons: buttons.len() as u32,
                pButtons: buttons.as_ptr(),
                nDefaultButton: default,
                pfCallback: Some(callback),
                lpCallbackData: default as isize,
                ..Default::default()
            };
            config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
            let mut pressed = 0i32;
            let hr = unsafe {
                task_dialog(&config, &mut pressed, std::ptr::null_mut(), std::ptr::null_mut())
            };
            if hr.is_ok() {
                // Esc / closing the window reports IDCANCEL → treat as the safe default
                return if prompt.buttons.iter().any(|b| b.0 == pressed) {
                    pressed
                } else {
                    default
                };
            }
            crate::log!("dialog: TaskDialogIndirect failed ({hr:?}), using MessageBox");
        }

        // Fallback: Yes = first (affirmative) button, No / Cancel = safe default.
        let first = prompt.buttons.first().copied().unwrap_or((default, "OK"));
        let fallback_title = HSTRING::from("WitBox - permission request");
        let text = HSTRING::from(format!(
            "{}\n\n{}\n\nYes = {}\nNo = {}",
            prompt.headline,
            prompt.detail,
            first.1,
            prompt.buttons.last().map(|b| b.1).unwrap_or("Cancel"),
        ));
        let (tx, rx) = std::sync::mpsc::channel();
        let (t_title, t_text) = (fallback_title.clone(), text);
        std::thread::spawn(move || {
            let r = unsafe {
                MessageBoxW(
                    None,
                    &t_text,
                    &t_title,
                    MB_YESNOCANCEL | MB_DEFBUTTON2 | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
                )
            };
            let _ = tx.send(r);
        });
        match rx.recv_timeout(ASK_TIMEOUT) {
            Ok(r) if r == IDYES => first.0,
            Ok(_) => default,
            Err(_) => {
                unsafe {
                    if let Ok(hwnd) = FindWindowW(w!("#32770"), &fallback_title) {
                        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                    }
                }
                default
            }
        }
    }
}
