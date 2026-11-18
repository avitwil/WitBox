//! Device-control agent: permission gate + execution of screenshot / input actions.

use std::{
    io::Cursor,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

use base64::Engine;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};

use crate::{
    app::{lock, Active, Decision, Shared, UserEvent, DENY_COOLDOWN, GRANT_WINDOW},
    screen,
};

/// Longest side of the screenshot sent to the server.
const MAX_SIDE: u32 = 1568;
const JPEG_QUALITY: u8 = 70;

pub type Job = (Value, mpsc::Sender<String>);

/// Starts the executor thread (requests run strictly one after another) and the small
/// watcher that expires the "controlling" indicator / grant windows.
pub fn spawn_executor(shared: Arc<Shared>) -> mpsc::Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    let s = shared.clone();
    std::thread::Builder::new()
        .name("control".into())
        .spawn(move || {
            let mut ctl = Controller::default();
            for (req, out) in rx {
                let resp = handle_request(&s, &mut ctl, &req);
                let _ = out.send(resp.to_string());
            }
        })
        .expect("spawn control thread");
    std::thread::Builder::new()
        .name("control-watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            shared.refresh_status();
        })
        .expect("spawn control watcher");
    tx
}

fn handle_request(shared: &Arc<Shared>, ctl: &mut Controller, req: &Value) -> Value {
    let id = req["id"].clone();
    let bot_id = req["botId"].as_str().unwrap_or("").to_string();
    let bot_name = match req["botName"].as_str() {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ if !bot_id.is_empty() => bot_id.clone(),
        _ => "A bot".to_string(),
    };
    let fail = |error: &str| json!({"type": "response", "id": id, "ok": false, "error": error});

    if let Err(e) = gate(shared, &bot_id, &bot_name) {
        crate::log!("control: {bot_name} -> {e}");
        return fail(e);
    }

    let action = &req["action"];
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ctl.execute(action)))
        .unwrap_or_else(|_| {
            ctl.reset();
            Err("internal error".to_string())
        });

    // The user may have pressed Stop / changed the level while the action ran: keep the
    // indicator only if the bot is still allowed.
    if gate_silent(shared, &bot_id) {
        mark_active(shared, &bot_id, &bot_name);
    }
    match result {
        Ok(result) => json!({"type": "response", "id": id, "ok": true, "result": result}),
        Err(e) => {
            crate::log!("control: action {} failed: {e}", action["type"]);
            fail(&e)
        }
    }
}

/// Enforces the per-bot permission level. Never trusts anything but local state.
fn gate(shared: &Arc<Shared>, bot_id: &str, bot_name: &str) -> Result<(), &'static str> {
    if !shared.control_available {
        return Err("not_enabled");
    }
    if bot_id.is_empty() {
        return Err("denied");
    }
    match shared.level(bot_id).as_str() {
        "always" => {}
        "ask" => {
            let now = Instant::now();
            let granted = lock(&shared.grants).get(bot_id).is_some_and(|exp| *exp > now);
            if !granted {
                if lock(&shared.denied_until).get(bot_id).is_some_and(|t| *t > now) {
                    return Err("denied");
                }
                let decision = crate::dialog::ask(shared, bot_name);
                crate::log!("control: {bot_name} asked for control -> {decision:?}");
                // The level may have been changed in the UI while the dialog was open.
                let level_now = shared.level(bot_id);
                if level_now == "never" {
                    return Err("denied");
                }
                match decision {
                    Decision::AllowOnce => {
                        lock(&shared.grants).insert(bot_id.to_string(), Instant::now() + GRANT_WINDOW);
                    }
                    Decision::Always => {
                        shared.set_permission(bot_id, "always");
                        shared.send(UserEvent::PermissionsChanged);
                    }
                    Decision::Deny => {
                        lock(&shared.denied_until)
                            .insert(bot_id.to_string(), Instant::now() + DENY_COOLDOWN);
                        return Err("denied");
                    }
                }
            }
        }
        _ => return Err("denied"),
    }
    mark_active(shared, bot_id, bot_name);
    Ok(())
}

fn gate_silent(shared: &Shared, bot_id: &str) -> bool {
    match shared.level(bot_id).as_str() {
        "always" => true,
        "ask" => lock(&shared.grants)
            .get(bot_id)
            .is_some_and(|exp| *exp > Instant::now()),
        _ => false,
    }
}

fn mark_active(shared: &Shared, bot_id: &str, bot_name: &str) {
    *lock(&shared.active) = Some(Active {
        bot_id: bot_id.to_string(),
        bot_name: bot_name.to_string(),
        last: Instant::now(),
    });
    shared.refresh_status();
}

#[derive(Default)]
struct Controller {
    enigo: Option<Enigo>,
}

fn num(v: &Value, key: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .ok_or_else(|| format!("missing or invalid \"{key}\""))
}

impl Controller {
    fn reset(&mut self) {
        self.enigo = None;
    }

    fn enigo(&mut self) -> Result<&mut Enigo, String> {
        if self.enigo.is_none() {
            let settings = Settings {
                // do not pop any OS permission prompt, never block on one
                open_prompt_to_get_permissions: false,
                ..Settings::default()
            };
            let e = Enigo::new(&settings).map_err(|e| format!("input injection unavailable: {e}"))?;
            self.enigo = Some(e);
        }
        Ok(self.enigo.as_mut().unwrap())
    }

    /// Maps a point given in screenshot pixels to real screen pixels.
    fn to_screen(x: f64, y: f64) -> Result<(i32, i32), String> {
        let g = screen::geometry()?;
        let scale = scale_for(g.width, g.height);
        let px = (x * scale).round().clamp(0.0, g.width.saturating_sub(1) as f64) as i32;
        let py = (y * scale).round().clamp(0.0, g.height.saturating_sub(1) as f64) as i32;
        Ok((g.x + px, g.y + py))
    }

    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let (sx, sy) = Self::to_screen(x, y)?;
        self.enigo()?
            .move_mouse(sx, sy, Coordinate::Abs)
            .map_err(|e| e.to_string())
    }

    fn execute(&mut self, action: &Value) -> Result<Value, String> {
        let ok = || Ok(json!({"ok": true}));
        let pause = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        match action["type"].as_str().unwrap_or("") {
            "screenshot" => screenshot(),
            "move" => {
                self.move_to(num(action, "x")?, num(action, "y")?)?;
                ok()
            }
            "click" => {
                let button = match action["button"].as_str().unwrap_or("left") {
                    "left" => Button::Left,
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    other => return Err(format!("unknown button \"{other}\"")),
                };
                let double = action["double"].as_bool().unwrap_or(false);
                self.move_to(num(action, "x")?, num(action, "y")?)?;
                pause(40);
                let e = self.enigo()?;
                e.button(button, Direction::Click).map_err(|e| e.to_string())?;
                if double {
                    pause(90);
                    e.button(button, Direction::Click).map_err(|e| e.to_string())?;
                }
                ok()
            }
            "drag" => {
                let (x1, y1) = (num(action, "x1")?, num(action, "y1")?);
                let (x2, y2) = (num(action, "x2")?, num(action, "y2")?);
                self.move_to(x1, y1)?;
                pause(60);
                self.enigo()?
                    .button(Button::Left, Direction::Press)
                    .map_err(|e| e.to_string())?;
                pause(80);
                let steps = 12;
                let mut res = Ok(());
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    res = self.move_to(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
                    if res.is_err() {
                        break;
                    }
                    pause(15);
                }
                pause(60);
                // always release, even if a move failed
                let rel = self
                    .enigo()?
                    .button(Button::Left, Direction::Release)
                    .map_err(|e| e.to_string());
                res.and(rel)?;
                ok()
            }
            "scroll" => {
                if action["x"].is_number() && action["y"].is_number() {
                    self.move_to(num(action, "x")?, num(action, "y")?)?;
                    pause(30);
                }
                let dx = action["dx"].as_f64().unwrap_or(0.0).round() as i32;
                let dy = action["dy"].as_f64().unwrap_or(0.0).round() as i32;
                let e = self.enigo()?;
                // enigo: positive = down / right, same as the contract (dy < 0 = up)
                if dy != 0 {
                    e.scroll(dy.clamp(-100, 100), Axis::Vertical).map_err(|e| e.to_string())?;
                }
                if dx != 0 {
                    e.scroll(dx.clamp(-100, 100), Axis::Horizontal).map_err(|e| e.to_string())?;
                }
                ok()
            }
            "type" => {
                let text = action["text"].as_str().ok_or("missing \"text\"")?;
                let e = self.enigo()?;
                // newlines / tabs are sent as real key presses, everything else as unicode text
                let mut chunk = String::new();
                let flush = |e: &mut Enigo, chunk: &mut String| -> Result<(), String> {
                    if !chunk.is_empty() {
                        e.text(chunk).map_err(|e| e.to_string())?;
                        chunk.clear();
                    }
                    Ok(())
                };
                for c in text.chars() {
                    match c {
                        '\r' => {}
                        '\n' | '\t' => {
                            flush(e, &mut chunk)?;
                            let key = if c == '\n' { Key::Return } else { Key::Tab };
                            e.key(key, Direction::Click).map_err(|e| e.to_string())?;
                        }
                        c => chunk.push(c),
                    }
                }
                flush(e, &mut chunk)?;
                ok()
            }
            "key" => {
                let keys = action["keys"].as_str().ok_or("missing \"keys\"")?;
                let combo = parse_keys(keys)?;
                let e = self.enigo()?;
                let (last, mods) = combo.split_last().ok_or("empty key combination")?;
                let mut pressed = Vec::new();
                let mut res = Ok(());
                for m in mods {
                    res = e.key(*m, Direction::Press).map_err(|e| e.to_string());
                    if res.is_err() {
                        break;
                    }
                    pressed.push(*m);
                    pause(15);
                }
                if res.is_ok() {
                    res = e.key(*last, Direction::Click).map_err(|e| e.to_string());
                    pause(15);
                }
                // always release held modifiers
                for m in pressed.iter().rev() {
                    let _ = e.key(*m, Direction::Release);
                }
                res?;
                ok()
            }
            "tap" | "swipe" | "global" | "open_app" => Err("unsupported".into()),
            "" => Err("missing action type".into()),
            other => Err(format!("unknown action \"{other}\"")),
        }
    }
}

/// real pixels per screenshot pixel
fn scale_for(width: u32, height: u32) -> f64 {
    let longest = width.max(height);
    if longest > MAX_SIDE {
        longest as f64 / MAX_SIDE as f64
    } else {
        1.0
    }
}

fn screenshot() -> Result<Value, String> {
    let cap = screen::capture()?;
    let scale = scale_for(cap.width, cap.height);
    let img = image::RgbImage::from_raw(cap.width, cap.height, cap.rgb)
        .ok_or("screen capture returned a malformed buffer")?;
    let img = if scale > 1.0 {
        let w = ((cap.width as f64 / scale).round() as u32).clamp(1, MAX_SIDE);
        let h = ((cap.height as f64 / scale).round() as u32).clamp(1, MAX_SIDE);
        image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut jpeg = Cursor::new(Vec::with_capacity(256 * 1024));
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&img)
        .map_err(|e| format!("jpeg encoding failed: {e}"))?;
    Ok(json!({
        "image": base64::engine::general_purpose::STANDARD.encode(jpeg.get_ref()),
        "width": img.width(),
        "height": img.height(),
    }))
}

/// Parses xdotool-style combos such as "ctrl+c", "ctrl+shift+Tab", "Return", "super", "+".
fn parse_keys(spec: &str) -> Result<Vec<Key>, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("empty key combination".into());
    }
    let mut tokens: Vec<&str> = Vec::new();
    if spec == "+" {
        tokens.push("+");
    } else {
        let (body, trailing_plus) = match spec.strip_suffix("++") {
            Some(b) => (b, true), // e.g. "ctrl++"
            None => (spec, false),
        };
        tokens.extend(body.split('+').map(str::trim).filter(|t| !t.is_empty()));
        if trailing_plus {
            tokens.push("+");
        }
    }
    tokens.iter().map(|t| parse_key(t)).collect()
}

fn parse_key(token: &str) -> Result<Key, String> {
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Ok(Key::Unicode(c));
    }
    let lower = token.to_ascii_lowercase();
    let key = match lower.as_str() {
        "ctrl" | "control" | "control_l" | "control_r" => Key::Control,
        "alt" | "alt_l" | "alt_r" | "option" => Key::Alt,
        "shift" | "shift_l" | "shift_r" => Key::Shift,
        "super" | "super_l" | "super_r" | "meta" | "win" | "windows" | "cmd" | "command" => Key::Meta,
        "return" | "enter" | "kp_enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "page_up" | "pageup" | "prior" => Key::PageUp,
        "page_down" | "pagedown" | "next" => Key::PageDown,
        "space" => Key::Space,
        "insert" => Key::Insert,
        "caps_lock" | "capslock" => Key::CapsLock,
        "plus" => Key::Unicode('+'),
        "minus" => Key::Unicode('-'),
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ => return Err(format!("unknown key \"{token}\"")),
    };
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_parsing() {
        assert_eq!(parse_keys("ctrl+c").unwrap(), vec![Key::Control, Key::Unicode('c')]);
        assert_eq!(
            parse_keys("ctrl+shift+Tab").unwrap(),
            vec![Key::Control, Key::Shift, Key::Tab]
        );
        assert_eq!(parse_keys("Return").unwrap(), vec![Key::Return]);
        assert_eq!(parse_keys("Page_Down").unwrap(), vec![Key::PageDown]);
        assert_eq!(parse_keys("BackSpace").unwrap(), vec![Key::Backspace]);
        assert_eq!(parse_keys("+").unwrap(), vec![Key::Unicode('+')]);
        assert_eq!(parse_keys("ctrl++").unwrap(), vec![Key::Control, Key::Unicode('+')]);
        assert_eq!(parse_keys("super").unwrap(), vec![Key::Meta]);
        assert_eq!(parse_keys("F12").unwrap(), vec![Key::F12]);
        assert!(parse_keys("ctrl+bogus").is_err());
        assert!(parse_keys("").is_err());
    }

    #[test]
    fn scaling() {
        assert_eq!(scale_for(1280, 800), 1.0);
        assert_eq!(scale_for(3136, 1000), 2.0);
        assert!((scale_for(1920, 1080) - 1920.0 / 1568.0).abs() < 1e-9);
    }
}
