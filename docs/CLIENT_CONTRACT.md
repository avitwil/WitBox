# WitBox — client app contract (Android / Windows / Linux)

WitBox is a self-hosted multi-bot agent system (Grok-Bot-like) running on the user's Kali
machine. The server serves a responsive web UI (phone / tablet / desktop layouts) and is reachable
**only over Tailscale** at:

    DEFAULT_SERVER_URL = (none — the user enters the address of their own server on first run, e.g. https://my-server.my-tailnet.ts.net)

(HTTPS with a valid Let's Encrypt cert from `tailscale serve`; MagicDNS name; tailnet IP 100.108.194.41.)
The native apps are thin shells: a full-window WebView that loads the server URL, plus native
services the web page cannot do itself. Server URL must be user-editable (first-run / settings
screen, persisted), defaulting to DEFAULT_SERVER_URL. If the server is unreachable show a friendly
native/HTML error page ("Is Tailscale connected?") with Retry and "Change server" buttons.

App name: **WitBox**. Package / id: `net.witbox.app`. Accent colour #D97757 on near-black
#0B0B0C. Icon: `assets/icon.svg` (+ pre-rendered PNGs in the same folder).

## 1. WebView shell
- Load `SERVER_URL/` . Enable JS, DOM storage, media (mic/camera permission grant for that origin),
  file upload (`<input type=file>`), file downloads (links with `download` attr or
  `Content-Disposition: attachment` → save to Downloads and tell the user), fullscreen video.
- External links (other origins) open in the system browser.
- Append ` WitBoxApp/<version> (<platform>)` to the User-Agent. platform ∈ android|windows|linux.
- Deep link: a notification tap opens `SERVER_URL/#/bot/<botId>`.

## 2. JS ⇄ native bridge
Web → native: one async message channel carrying a JSON string
`{"id": <number>, "cmd": "<name>", "args": {...}}`:
- Android: `window.WitBoxNative.postMessage(jsonString)` (`@JavascriptInterface`)
- Desktop (wry): `window.ipc.postMessage(jsonString)`

Native → web (evaluate JS in the page):
- reply:  `window.cbNative && window.cbNative.resolve(<id>, <resultObject>)`
  (on failure the result object is `{"error": "message"}`)
- event:  `window.cbNative && window.cbNative.emit("<event>", <dataObject>)`

Commands (every platform must answer every command; unsupported → `{"error":"unsupported"}`):

| cmd | args | result |
|---|---|---|
| `getDeviceInfo` | – | `{deviceId, name, platform, appVersion, controlAvailable:boolean, controlEnabled:boolean}` — deviceId is a random UUID persisted on first run; name = device/host name; controlAvailable = this build can be remote-controlled; controlEnabled = prerequisites satisfied (Android: accessibility service on) |
| `getPermissions` | – | `{ "<botId>": "always" | "ask" | "never", ... }` (missing ⇒ `never`) |
| `setPermission` | `{botId, level}` | `{ok:true}` — persisted locally on the device only |
| `openControlSetup` | – | Android: open Accessibility settings. Desktop: `{ok:true}` no-op |
| `startListening` | `{lang}` e.g. `he-IL` | `{ok:true}`; then events `speechPartial {text}`, `speechFinal {text}`, `speechEnd {}`, `speechError {message}` (Android SpeechRecognizer). Desktop: unsupported |
| `stopListening` | – | `{ok:true}` |
| `speak` | `{text, lang}` | `{ok:true}`; event `speakEnd {}` when finished (Android TextToSpeech). Desktop: unsupported |
| `stopSpeaking` | – | `{ok:true}` |
| `getServerUrl` | – | `{url}` |
| `changeServer` | – | opens the native "server URL" screen/dialog |

## 3. Notifications channel (native, must work with the UI closed / in background)
WebSocket: `wss://<host>/ws/notify?deviceId=<id>&name=<name>&platform=<platform>`
Server → client JSON text frames:
`{"type":"notification","id":"...","botId":"...","botName":"...","title":"...","body":"...","url":"/#/bot/<botId>","priority":"high"|"normal"}`
and `{"type":"ping"}` every 25 s (reply `{"type":"pong"}`). Reconnect with backoff (2s→60s) forever.
Show an OS notification (Android: notification channel "WitBox alerts", high importance,
POST_NOTIFICATIONS runtime permission, foreground service with a low-priority persistent
"WitBox connected" notification so the socket survives; start on boot. Desktop: native toast +
tray icon; app keeps running in tray when the window is closed, tray menu Open / Quit).
Tapping opens the app at `url`.

## 4. Device-control agent (bots controlling THIS device)
WebSocket: `wss://<host>/ws/device?deviceId=<id>&name=<name>&platform=<platform>`
(same reconnect policy; may be the same connection logic as §3 but it is a separate socket.)

Server → device: `{"type":"request","id":"<rid>","botId":"...","botName":"...","action":{...}}`
Device → server: `{"type":"response","id":"<rid>","ok":true,"result":{...}}` or
`{"type":"response","id":"<rid>","ok":false,"error":"denied"|"not_enabled"|"<message>"}`
Also `{"type":"ping"}` / `{"type":"pong"}` as above.

**Permission gate (enforced on the device, never on the server):** per botId level
- `never` (default) → respond `denied` immediately
- `always` → execute
- `ask` → show a native modal dialog "‹botName› wants to control this device" with
  **Allow once (5 min)** / **Always allow** / **Deny**; "Allow once" grants a 5-minute window for
  that bot; no answer in 60 s ⇒ denied.
While a bot is controlling the device show a visible indicator (Android: ongoing notification
"‹botName› is controlling this device — tap to stop"; desktop: tray tooltip/notification), and a
"Stop" action that revokes the current window and sets that bot to `ask`.

Actions (coordinates are in pixels of the returned screenshot):
- `{"type":"screenshot"}` → result `{image:"<base64 JPEG, quality ~70, longest side ≤ 1568 px>", width, height}`
  (width/height = size of the encoded image; the agent maps coordinates back to real screen pixels)
- `{"type":"click","x":..,"y":..,"button":"left"|"right"|"middle","double":false}`
- `{"type":"move","x":..,"y":..}`
- `{"type":"drag","x1":..,"y1":..,"x2":..,"y2":..}`
- `{"type":"scroll","x":..,"y":..,"dx":0,"dy":-3}` (dy<0 = scroll up, in wheel notches)
- `{"type":"type","text":"..."}` (unicode text)
- `{"type":"key","keys":"ctrl+c"}` (xdotool-style names: ctrl alt shift super, Return, Tab, Escape, BackSpace, Delete, Up/Down/Left/Right, Home, End, Page_Up, Page_Down, F1..F12, single chars)
- Android only: `{"type":"tap","x","y"}`, `{"type":"swipe","x1","y1","x2","y2","ms":300}`,
  `{"type":"global","name":"back"|"home"|"recents"|"notifications"}`, `{"type":"open_app","package":"..."}`;
  on Android `click` = tap, `drag` = swipe, `type` = set text on focused node (ACTION_SET_TEXT / paste),
  `key` with Return = IME enter action if possible.
Every non-screenshot action returns `{ok:true}`.
Android implementation: AccessibilityService (`takeScreenshot` API 30+, `dispatchGesture`,
`performGlobalAction`). Desktop: native screen capture + input injection (Windows: GDI/SendInput;
Linux: X11).

## 5. Deliverables (put final binaries in `downloads/`)
- Android: `WitBox.apk` — debug-signed or self-signed release, minSdk 26, targetSdk 34/35, installable on
  Samsung S24 (phone) and Tab S9 Ultra (tablet; allow all orientations, resizable, the web UI is responsive).
- Windows: `WitBox-windows-x64.exe` — single portable exe, no installer, no runtime deps beyond the
  WebView2 runtime that ships with Windows 10/11.
- Linux: `witbox-linux-x86_64` — single binary for Kali/Debian (may dynamically link libwebkit2gtk-4.1 / gtk3,
  which Kali ships by default; nothing else).
Source lives in `apps/<android|desktop>/`.
