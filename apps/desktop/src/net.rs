//! Background WebSocket clients: `/ws/notify` (notifications) and `/ws/device`
//! (remote-control requests). Blocking tungstenite + rustls, one thread per socket,
//! reconnect forever with 2s → 60s backoff.

use std::{
    io::ErrorKind,
    net::{TcpStream, ToSocketAddrs},
    sync::{mpsc, Arc, OnceLock},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tungstenite::{stream::MaybeTlsStream, Connector, Message, WebSocket};

use crate::app::{Shared, UserEvent};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

/// The server pings every 25 s; if nothing at all arrives for this long the link is dead.
const DEAD_AFTER: Duration = Duration::from_secs(80);
/// Socket read timeout = how long a queued outgoing frame can wait at most.
const POLL: Duration = Duration::from_millis(40);

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("rustls protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

/// TCP reachability check used by the UI before loading the server page.
pub fn probe(server_url: &str) -> Result<(), String> {
    let url = url::Url::parse(server_url).map_err(|e| e.to_string())?;
    tcp_connect(&url, Duration::from_secs(6)).map(|_| ())
}

fn tcp_connect(url: &url::Url, timeout: Duration) -> Result<TcpStream, String> {
    let host = url.host_str().ok_or("no host in URL")?;
    let port = url.port_or_known_default().ok_or("no port in URL")?;
    // IPv6 literals come back bracketed from host_str()
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {host}: {e}"))?
        .collect();
    let mut last = format!("cannot resolve {host}");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => last = format!("cannot connect to {host}:{port}: {e}"),
        }
    }
    Err(last)
}

fn set_read_timeout(ws: &Ws, t: Duration) {
    let res = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(t)),
        MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(Some(t)),
        _ => Ok(()),
    };
    let _ = res;
}

fn connect(ws_url: &str) -> Result<Ws, String> {
    let url = url::Url::parse(ws_url).map_err(|e| e.to_string())?;
    let stream = tcp_connect(&url, Duration::from_secs(10))?;
    let _ = stream.set_nodelay(true);
    // generous timeouts for the TLS + WebSocket handshake
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let connector = if url.scheme() == "wss" {
        Connector::Rustls(tls_config())
    } else {
        Connector::Plain
    };
    let (ws, _resp) = tungstenite::client_tls_with_config(ws_url, stream, None, Some(connector))
        .map_err(|e| format!("handshake failed: {e}"))?;
    // short read timeout afterwards so the loop can interleave writes and shutdown checks
    set_read_timeout(&ws, POLL);
    Ok(ws)
}

/// Handler invoked for every JSON text frame except ping. `out` queues frames to send.
type Handler = Box<dyn FnMut(Value, &mpsc::Sender<String>) + Send>;

fn session(shared: &Shared, ws: &mut Ws, url: &str, channel: &str, handler: &mut Handler) -> String {
    let (tx, rx) = mpsc::channel::<String>();
    let mut last_rx = Instant::now();
    loop {
        while let Ok(out) = rx.try_recv() {
            if let Err(e) = ws.send(Message::text(out)) {
                return format!("send failed: {e}");
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                last_rx = Instant::now();
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                if v["type"] == "ping" {
                    if let Err(e) = ws.send(Message::text(r#"{"type":"pong"}"#)) {
                        return format!("send failed: {e}");
                    }
                } else {
                    handler(v, &tx);
                }
            }
            Ok(Message::Close(_)) => return "closed by server".into(),
            Ok(_) => last_rx = Instant::now(), // ws-level ping/pong/binary
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
            Err(e) => return format!("read failed: {e}"),
        }
        if last_rx.elapsed() > DEAD_AFTER {
            return "no traffic (server ping missing)".into();
        }
        if shared.ws_url(channel) != url {
            let _ = ws.close(None);
            let _ = ws.flush();
            return "server URL changed".into();
        }
    }
}

fn run(shared: Arc<Shared>, channel: &'static str, mut handler: Handler) {
    let mut backoff = Duration::from_secs(2);
    loop {
        if !shared.has_server() {
            // no server configured yet: wait quietly until the user enters one
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let url = shared.ws_url(channel);
        match connect(&url) {
            Ok(mut ws) => {
                crate::log!("ws/{channel}: connected");
                backoff = Duration::from_secs(2);
                let why = session(&shared, &mut ws, &url, channel, &mut handler);
                crate::log!("ws/{channel}: disconnected ({why})");
            }
            Err(e) => crate::log!("ws/{channel}: {e} (retry in {}s)", backoff.as_secs()),
        }
        // interruptible sleep: a changed server URL reconnects immediately
        let until = Instant::now() + backoff;
        let mut changed = false;
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(250));
            if shared.ws_url(channel) != url {
                changed = true;
                break;
            }
        }
        backoff = if changed {
            Duration::from_secs(2)
        } else {
            (backoff * 2).min(Duration::from_secs(60))
        };
    }
}

pub fn spawn_notify(shared: Arc<Shared>) {
    let s = shared.clone();
    let handler: Handler = Box::new(move |v, _out| {
        if v["type"] != "notification" {
            return;
        }
        let str_of = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let mut title = str_of("title");
        if title.is_empty() {
            title = str_of("botName");
        }
        if title.is_empty() {
            title = crate::app::APP_NAME.to_string();
        }
        let path = match (v["url"].as_str(), v["botId"].as_str()) {
            (Some(u), _) if !u.is_empty() => Some(u.to_string()),
            (_, Some(b)) if !b.is_empty() => Some(format!("/#/bot/{b}")),
            _ => None,
        };
        s.send(UserEvent::Notify {
            title,
            body: str_of("body"),
            path,
            urgent: v["priority"] == "high",
        });
    });
    std::thread::Builder::new()
        .name("ws-notify".into())
        .spawn(move || run(shared, "notify", handler))
        .expect("spawn ws-notify");
}

pub fn spawn_device(shared: Arc<Shared>) {
    let jobs = crate::control::spawn_executor(shared.clone());
    let handler: Handler = Box::new(move |v, out| {
        if v["type"] != "request" {
            return;
        }
        if jobs.send((v.clone(), out.clone())).is_err() {
            let _ = out.send(
                json!({"type": "response", "id": v["id"], "ok": false, "error": "agent unavailable"})
                    .to_string(),
            );
        }
    });
    std::thread::Builder::new()
        .name("ws-device".into())
        .spawn(move || run(shared, "device", handler))
        .expect("spawn ws-device");
}
