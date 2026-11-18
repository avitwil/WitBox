//! Built-in pages (loading, "server unreachable", "server URL" settings), rendered with
//! `load_html`. They talk to the native side with private `_…` bridge commands that are
//! only accepted while one of these pages is showing.

use serde_json::json;

use base64::Engine;

use crate::app::{CREDIT, SERVER_URL_EXAMPLE};

pub enum Page<'a> {
    Loading,
    /// Server unreachable; the string is a technical detail line.
    Error(&'a str),
    /// Server URL editor; `can_cancel` = there is a working page to go back to.
    Settings,
}

const TEMPLATE: &str = r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WitBox</title>
<style>
:root{--bg:#0B0B0C;--panel:#151517;--line:#2a2a2e;--text:#ECEAE6;--muted:#9a9790;--accent:#D97757;--accent-ink:#1a0e09}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;
display:flex;align-items:center;justify-content:center;padding:24px;-webkit-user-select:none;user-select:none}
main{width:100%;max-width:440px;text-align:center}
.logo{width:84px;height:84px;margin:0 auto 20px;border-radius:20px;background:#101011;border:1px solid var(--line);
display:flex;align-items:center;justify-content:center;overflow:hidden}
.logo img{width:100%;height:100%;display:block}
.credit{margin-top:28px;font-size:12px;color:#77746e}
input::placeholder{color:#6b6862}
h1{font-size:22px;font-weight:650;margin:0 0 8px;letter-spacing:-.01em;text-wrap:balance}
p{margin:0 0 6px;color:var(--muted);text-wrap:pretty}
.detail{font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#77746e;margin-top:12px;overflow-wrap:anywhere;min-height:18px}
.detail.bad{color:#e58a6c}
form{margin:22px 0 0;text-align:left}
label{display:block;font-size:12px;color:var(--muted);margin:0 0 6px 2px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);
font:14px ui-monospace,"Cascadia Mono",Consolas,monospace;outline:none;-webkit-user-select:text;user-select:text}
input:focus{border-color:var(--accent)}
.row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:22px}
button{font:inherit;font-weight:600;padding:10px 18px;border-radius:10px;border:1px solid var(--line);background:var(--panel);
color:var(--text);cursor:pointer}
button:hover{border-color:#44444a}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.primary:hover{filter:brightness(1.07)}
button.link{background:none;border-color:transparent;color:var(--muted);font-weight:500}
.spin{width:26px;height:26px;margin:22px auto 0;border-radius:50%;border:3px solid var(--line);border-top-color:var(--accent);
animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:3s}}
[hidden]{display:none!important}
</style></head><body><main>
<div class="logo"><img alt="" src="data:image/png;base64,/*ICON*/"></div>
<h1 id="h"></h1><p id="p"></p>
<div id="spin" class="spin" hidden></div>
<form id="f" hidden><label for="url">Server address</label>
<input id="url" type="text" inputmode="url" spellcheck="false" autocomplete="off" autocapitalize="off"></form>
<div id="detail" class="detail"></div>
<div class="row" id="row"></div>
<div class="credit" id="credit"></div>
</main><script>
var D = /*DATA*/;
function send(cmd, args){ window.ipc.postMessage(JSON.stringify({id: 1, cmd: cmd, args: args || {}})); }
var $ = function(id){ return document.getElementById(id); };
window.cbNative = {
  resolve: function(id, res){ if (res && res.error){ $("detail").textContent = res.error; $("detail").className = "detail bad"; } },
  emit: function(){}
};
function btn(label, cls, fn){ var b = document.createElement("button"); b.type = "button"; b.textContent = label;
  if (cls) b.className = cls; b.onclick = fn; $("row").appendChild(b); return b; }
$("credit").textContent = D.credit;
if (D.mode === "loading") {
  $("h").textContent = "Connecting…"; $("p").textContent = D.url; $("spin").hidden = false;
} else if (D.mode === "error") {
  $("h").textContent = "Can’t reach WitBox";
  $("p").textContent = "Is Tailscale connected? The server at " + D.url + " did not answer.";
  $("detail").textContent = D.detail || "";
  btn("Retry", "primary", function(){ send("_retry"); }).focus();
  btn("Change server", "", function(){ send("_changeServer"); });
} else {
  $("h").textContent = D.url ? "Server address" : "Welcome to WitBox";
  $("p").textContent = "WitBox runs on your own server and is reachable only over your Tailscale network. Enter your server\u2019s address.";
  $("f").hidden = false; $("url").value = D.url; $("url").placeholder = D.example;
  var save = function(){ send("_saveServer", {url: $("url").value}); };
  $("f").onsubmit = function(e){ e.preventDefault(); save(); };
  btn("Save & connect", "primary", save);
  if (D.url) btn("Cancel", "link", function(){ send("_cancel"); });
  $("url").focus(); $("url").select();
}
</script></body></html>
"##;

pub fn render(page: Page<'_>, server_url: &str) -> String {
    let (mode, detail) = match page {
        Page::Loading => ("loading", ""),
        Page::Error(d) => ("error", d),
        Page::Settings => ("settings", ""),
    };
    let data = json!({
        "mode": mode,
        "url": server_url,
        "detail": detail,
        "example": SERVER_URL_EXAMPLE,
        "credit": CREDIT,
    })
    .to_string()
    // never let data close the <script> element
    .replace("</", "<\\/");
    let icon = base64::engine::general_purpose::STANDARD.encode(include_bytes!("../assets/icon-64.png"));
    TEMPLATE.replace("/*ICON*/", &icon).replace("/*DATA*/", &data)
}
