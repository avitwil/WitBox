#!/usr/bin/env bash
# WitBox installer for Linux — created by Avi Twil.  https://witbox.avitwil.io
#
# Installs the WitBox server on this machine and exposes it ONLY to your own Tailscale network.
# Put this script next to witbox-linux-x86_64.tar.gz and run it as your normal user (it asks for sudo when needed):
#
#     ./install.sh
#
# Without the package next to it, the script downloads the latest release from GitHub.
# Supported: x86_64 Linux with systemd — Debian/Ubuntu/Kali/Mint (apt), Fedora/RHEL family (dnf),
# Arch/Manjaro (pacman), openSUSE (zypper).
set -euo pipefail

REPO="${WITBOX_REPO:-avitwil/WitBox}"
PKG_NAME="witbox-linux-x86_64.tar.gz"
NODE_MAJOR=24
NOVNC_VERSION=1.6.0
DIR="/opt/witbox"; LANG_UI=""; USER_NAME=""; VM_RAM=""; VM_CPU=""
WITH_VM=1; WITH_VOICE=""; WITH_STT=0; ASSUME_YES=0; DEPS_ONLY=0; DO_UNINSTALL=0; NO_SERVICE=0

usage() { cat <<'EOF'
WitBox installer

  ./install.sh [options]

  --dir DIR          install directory (default /opt/witbox)
  --lang he|en       interface language (default: asked; Hebrew if the system locale is Hebrew)
  --name NAME        how the bots should call you
  --vm-ram GB        memory for the bots' shared computer (default: half of the RAM, 4-16 GB)
  --vm-cpus N        CPU cores for the shared computer (default: half of the cores, 2-6)
  --no-vm            do not build the bots' shared computer now (later: witbox build-vm)
  --voice            install the natural Hebrew voice for voice chat (default when the language is Hebrew; ~700 MB)
  --no-voice         skip it
  --stt              build whisper.cpp for server-side speech recognition (only needed by the desktop apps' microphone; ~600 MB)
  --yes              do not ask questions, take the defaults
  --deps-only        only install the system packages, then stop
  --no-service       install everything but do not create/start the systemd services or touch Tailscale
  --uninstall        stop and remove WitBox (keeps your data unless you confirm deleting it)
  -h, --help
EOF
}
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --lang) LANG_UI="$2"; shift 2;; --name) USER_NAME="$2"; shift 2;;
  --vm-ram) VM_RAM="$2"; shift 2;; --vm-cpus) VM_CPU="$2"; shift 2;;
  --no-vm) WITH_VM=0; shift;; --voice) WITH_VOICE=1; shift;; --no-voice) WITH_VOICE=0; shift;; --stt) WITH_STT=1; shift;;
  --yes|-y) ASSUME_YES=1; shift;; --deps-only) DEPS_ONLY=1; shift;; --no-service) NO_SERVICE=1; shift;; --uninstall) DO_UNINSTALL=1; shift;;
  -h|--help) usage; exit 0;; *) echo "unknown option: $1" >&2; usage; exit 2;;
esac; done

c_b=$'\033[1m'; c_c=$'\033[1;36m'; c_g=$'\033[1;32m'; c_y=$'\033[1;33m'; c_r=$'\033[1;31m'; c_0=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$c_c" "$*" "$c_0"; }
ok()   { printf '%s  ✓ %s%s\n' "$c_g" "$*" "$c_0"; }
warn() { printf '%s  ! %s%s\n' "$c_y" "$*" "$c_0"; }
die()  { printf '%s  ✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
ask()  { # ask "question" default -> answer in REPLY
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then REPLY="$2"; return; fi
  read -r -p "$1 [$2]: " REPLY || true; REPLY="${REPLY:-$2}"; }
yesno() { ask "$1 (y/n)" "$2"; case "$REPLY" in y|Y|yes|כן) return 0;; *) return 1;; esac; }

printf '%s\n' "$c_b" '  __        ___ _   ____' ' \ \      / (_) |_| __ )  _____  __' '  \ \ /\ / /| | __|  _ \ / _ \ \/ /' '   \ V  V / | | |_| |_) | (_) >  <' '    \_/\_/  |_|\__|____/ \___/_/\_\   by Avi Twil' "$c_0"

[ "$(uname -s)" = Linux ] || die "this installer is for Linux. On Windows run WitBox-Setup.exe (it sets the server up inside WSL2)."
[ "$(uname -m)" = x86_64 ] || die "only x86_64 is supported (this machine is $(uname -m))."
[ "$(id -u)" != 0 ] || die "run this as your normal user, not as root — the bots run under your account. sudo is asked for when needed."
have sudo || die "sudo is required."
RUN_USER="$(id -un)"; RUN_GROUP="$(id -gn)"
SUDO() { sudo "$@"; }

# ---------------------------------------------------------------- uninstall
if [ "$DO_UNINSTALL" = 1 ]; then
  step "Removing WitBox"
  SUDO systemctl disable --now witbox witbox-vm 2>/dev/null || true
  SUDO rm -f /etc/systemd/system/witbox.service /etc/systemd/system/witbox-vm.service /etc/sudoers.d/witbox /usr/local/bin/witbox
  SUDO systemctl daemon-reload || true
  have tailscale && SUDO tailscale serve reset 2>/dev/null || true
  if [ -d "$DIR" ]; then
    if yesno "Delete $DIR including all bots, chats, the Brain and the shared computer? This cannot be undone" n; then SUDO rm -rf "$DIR"; ok "deleted $DIR"; else ok "kept $DIR (your data is in $DIR/data)"; fi
  fi
  ok "WitBox was removed. Tailscale and the system packages were left installed."; exit 0
fi

# ---------------------------------------------------------------- 1. system packages
step "1/9  System packages"
PM=""; for p in apt-get dnf pacman zypper; do have "$p" && { PM="$p"; break; }; done
[ -n "$PM" ] || die "no supported package manager found (apt, dnf, pacman or zypper)."
case "$PM" in
  apt-get) PKGS="ca-certificates curl tar xz-utils openssl socat openssh-client xorriso qemu-system-x86 qemu-utils xvfb x11vnc xdotool xclip imagemagick ffmpeg procps python3"
           ALT="freerdp3-x11 freerdp2-x11"
           inst() { SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"; }; SUDO apt-get update -q || warn "apt-get update failed; continuing";;
  dnf)     PKGS="ca-certificates curl tar xz openssl socat openssh-clients xorriso qemu-kvm qemu-img xorg-x11-server-Xvfb x11vnc xdotool xclip ImageMagick procps-ng python3 freerdp"
           ALT="ffmpeg-free ffmpeg"
           inst() { SUDO dnf install -y -q "$@"; };;
  pacman)  PKGS="ca-certificates curl tar xz openssl socat openssh libisoburn qemu-base xorg-server-xvfb x11vnc xdotool xclip imagemagick ffmpeg procps-ng python freerdp"
           ALT=""
           inst() { SUDO pacman -S --noconfirm --needed "$@"; }; SUDO pacman -Sy --noconfirm >/dev/null || true;;
  zypper)  PKGS="ca-certificates curl tar xz openssl socat openssh-clients xorriso qemu-x86 qemu-tools xorg-x11-server-Xvfb x11vnc xdotool xclip ImageMagick ffmpeg procps python3 freerdp"
           ALT="xorg-x11-server-extra"
           inst() { SUDO zypper --non-interactive install --no-recommends "$@"; };;
esac
# shellcheck disable=SC2086
inst $PKGS >/dev/null 2>&1 || { warn "installing everything at once failed; installing package by package"; for p in $PKGS; do inst "$p" >/dev/null 2>&1 || warn "could not install $p"; done; }
case "$PM" in
  apt-get) have xfreerdp3 || have xfreerdp || inst freerdp3-x11 >/dev/null 2>&1 || inst freerdp2-x11 >/dev/null 2>&1 || true;;
  dnf)     have ffmpeg || inst ffmpeg-free >/dev/null 2>&1 || inst ffmpeg >/dev/null 2>&1 || true;;
  zypper)  have Xvfb || inst xorg-x11-server-extra >/dev/null 2>&1 || true;;
esac
MISSING=""
for b in curl tar xz openssl socat ssh ssh-keygen xorriso qemu-system-x86_64 qemu-img Xvfb x11vnc xdotool xclip import ffmpeg; do have "$b" || MISSING="$MISSING $b"; done
have xfreerdp3 || have xfreerdp || MISSING="$MISSING xfreerdp"
if [ -n "$MISSING" ]; then
  warn "these programs are still missing:$MISSING"
  warn "WitBox itself will run, but the bots' shared computer needs: qemu, Xvfb, x11vnc, xfreerdp, xdotool, xclip, import (ImageMagick)."
  for b in curl tar xz openssl; do case " $MISSING " in *" $b "*) die "$b is required to continue";; esac; done
else ok "all system programs are installed ($PM)"; fi
[ "$DEPS_ONLY" = 1 ] && { ok "--deps-only: stopping here"; exit 0; }

have systemctl && [ -d /run/systemd/system ] || { [ "$NO_SERVICE" = 1 ] || die "systemd is required to run WitBox as a service (use --no-service to install without it)."; }

# ---------------------------------------------------------------- 2. questions
step "2/9  A few questions"
if [ -z "$LANG_UI" ]; then case "${LANG:-}${LC_ALL:-}" in he*|*he_IL*) d=he;; *) d=en;; esac; ask "Interface language — he (עברית) or en (English)" "$d"; LANG_UI="$REPLY"; fi
[ "$LANG_UI" = he ] || LANG_UI=en
if [ -z "$USER_NAME" ]; then ask "Your first name (how the bots call you)" "$(getent passwd "$RUN_USER" | cut -d: -f5 | cut -d, -f1 | awk '{print $1}')"; USER_NAME="$REPLY"; fi
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo); CORES=$(nproc)
[ -n "$VM_RAM" ] || { VM_RAM=$((MEM_GB / 2)); [ "$VM_RAM" -gt 16 ] && VM_RAM=16; [ "$VM_RAM" -lt 4 ] && VM_RAM=4; }
[ -n "$VM_CPU" ] || { VM_CPU=$((CORES / 2)); [ "$VM_CPU" -gt 6 ] && VM_CPU=6; [ "$VM_CPU" -lt 2 ] && VM_CPU=2; }
if [ "$WITH_VM" = 1 ]; then
  if [ ! -e /dev/kvm ]; then warn "no /dev/kvm: hardware virtualization is off or unavailable (common on cloud VPS). The bots' shared computer is skipped; everything else works."; WITH_VM=0
  elif [ "$MEM_GB" -lt 7 ]; then warn "only ${MEM_GB} GB RAM: the shared computer needs at least 4 GB for itself."; yesno "Build the bots' shared computer anyway?" n || WITH_VM=0
  else ok "bots' shared computer: ${VM_RAM} GB RAM, ${VM_CPU} cores (of ${MEM_GB} GB / ${CORES})"; fi
fi
if [ -z "$WITH_VOICE" ]; then if [ "$LANG_UI" = he ]; then yesno "Install the natural Hebrew voice for voice chat (about 700 MB; free for non-commercial use)?" y && WITH_VOICE=1 || WITH_VOICE=0; else WITH_VOICE=0; fi; fi

# ---------------------------------------------------------------- 3. files
step "3/9  WitBox files → $DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -f "$SRC_DIR/$PKG_NAME" ]; then PKG="$SRC_DIR/$PKG_NAME"; ok "using $PKG"
elif [ -f "$SRC_DIR/server/index.mjs" ] && [ -f "$SRC_DIR/VERSION" ]; then PKG=""; ok "installing from the source tree $SRC_DIR"
else
  PKG="$TMP/$PKG_NAME"; echo "  downloading the latest release of $REPO"
  curl -fL --retry 3 --progress-bar -o "$PKG" "https://github.com/$REPO/releases/latest/download/$PKG_NAME" || die "download failed. Put $PKG_NAME next to install.sh and run again."
fi
SUDO mkdir -p "$DIR"; SUDO chown "$RUN_USER:$RUN_GROUP" "$DIR"
[ -d "$DIR/data" ] && ok "existing installation found — upgrading, your data is kept"
[ "$NO_SERVICE" = 1 ] || { systemctl is-active -q witbox 2>/dev/null && SUDO systemctl stop witbox || true; }
if [ -n "$PKG" ]; then tar -xzf "$PKG" -C "$DIR" --strip-components=1
else for d in server web assets vm tts docs downloads bin; do [ -e "$SRC_DIR/$d" ] && { mkdir -p "$DIR/$d"; tar -C "$SRC_DIR/$d" --exclude=node_modules --exclude='*.qcow2' --exclude='*.sock' --exclude='*.log' --exclude=models --exclude=src --exclude=.venv -cf - . | tar -C "$DIR/$d" -xf -; }; done
  cp "$SRC_DIR/VERSION" "$SRC_DIR/install.sh" "$DIR/"; cp "$SRC_DIR"/LICENSE* "$SRC_DIR"/README*.md "$DIR/" 2>/dev/null || true; fi
mkdir -p "$DIR/data" "$DIR/runtime" "$DIR/vendor" "$DIR/downloads"; chmod 700 "$DIR/data"
chmod +x "$DIR"/vm/*.sh "$DIR/vm/cb" "$DIR/vm/pcsh" "$DIR/bin/witbox" 2>/dev/null || true
ok "WitBox $(cat "$DIR/VERSION") unpacked"

# ---------------------------------------------------------------- 4. Node.js + server modules + noVNC
step "4/9  Node.js runtime and server modules"
NODE="$DIR/runtime/node/bin/node"
if [ ! -x "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $2}')"; sum="$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $1}')"
  [ -n "$file" ] || die "could not find a Node.js $NODE_MAJOR build to download"
  curl -fL --retry 3 --progress-bar -o "$TMP/node.tar.xz" "$base/$file"
  echo "$sum  $TMP/node.tar.xz" | sha256sum -c - >/dev/null || die "Node.js download is corrupted (checksum mismatch)"
  rm -rf "$DIR/runtime/node"; mkdir -p "$DIR/runtime/node"; tar -xJf "$TMP/node.tar.xz" -C "$DIR/runtime/node" --strip-components=1
fi
ok "Node.js $("$NODE" --version) (private copy in $DIR/runtime/node)"
export PATH="$DIR/runtime/node/bin:$PATH"
( cd "$DIR/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ) || die "npm could not install the server modules"
CLAUDE_BIN="$(ls "$DIR"/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64*/claude 2>/dev/null | head -n1 || true)"
[ -x "$CLAUDE_BIN" ] || die "the Claude Code runtime was not installed with the Agent SDK"
ok "server modules installed (Claude Agent SDK, Claude Code $("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}'))"
if [ ! -f "$DIR/vendor/novnc/core/rfb.js" ]; then
  curl -fsSL --retry 3 -o "$TMP/novnc.tgz" "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" && { rm -rf "$DIR/vendor/novnc"; mkdir -p "$DIR/vendor/novnc"; tar -xzf "$TMP/novnc.tgz" -C "$DIR/vendor/novnc" --strip-components=1; ok "noVNC $NOVNC_VERSION (live view of the bots' desktops)"; } || warn "could not download noVNC; the live desktop view will not work until it is in $DIR/vendor/novnc"
fi

# ---------------------------------------------------------------- 5. settings
step "5/9  Settings"
CFG="$DIR/data/config.env"
setcfg() { touch "$CFG"; if grep -q "^$1=" "$CFG"; then :; else printf '%s=%s\n' "$1" "$2" >> "$CFG"; fi; }
setcfg VM_CPUS "$VM_CPU"; setcfg VM_RAM_GB "$VM_RAM"; setcfg WITBOX_LANG "$LANG_UI"; setcfg WITBOX_USER_NAME "$(printf '%s' "$USER_NAME" | tr -d '"\n')"
ok "saved $CFG"

# ---------------------------------------------------------------- 6. Claude account
step "6/9  Your Claude account"
if "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then ok "already signed in to Claude on this machine"
else
  echo "  WitBox runs on your own Claude subscription (Pro / Max / Team). A sign-in link will be shown:"
  echo "  open it in a browser, approve, and paste the code back here."
  if [ -t 0 ]; then "$CLAUDE_BIN" auth login || warn "sign-in did not finish. Run 'witbox login' later — the bots cannot answer until you do."
  else warn "no terminal for the sign-in. Run 'witbox login' afterwards."; fi
fi

# ---------------------------------------------------------------- 7. optional voice + speech models
step "7/9  Voice (optional)"
if [ "$WITH_VOICE" = 1 ]; then
  if ! have uv && [ ! -x "$HOME/.local/bin/uv" ]; then curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 || warn "could not install uv"; fi
  UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
  if [ -x "$UV" ]; then
    mkdir -p "$DIR/tts/models" "$DIR/tts/src"
    ( cd "$DIR/tts/src" && "$UV" venv -q --python 3.12 .venv && "$UV" pip install -q -p .venv "phonikud==0.4.1" "phonikud-onnx==1.0.6" "piper-onnx==1.0.6" "soundfile>=0.13.1" ) || warn "could not create the voice environment"
    dl() { [ -s "$DIR/tts/models/$2" ] || curl -fL --retry 3 --progress-bar -o "$DIR/tts/models/$2" "$1" || warn "download failed: $2"; }
    dl https://huggingface.co/thewh1teagle/phonikud-onnx/resolve/main/phonikud-1.0.int8.onnx phonikud-1.0.int8.onnx
    dl https://huggingface.co/thewh1teagle/phonikud-tts-checkpoints/resolve/main/shaul.onnx shaul.onnx
    dl https://huggingface.co/thewh1teagle/phonikud-tts-checkpoints/resolve/main/model.config.json model.config.json
    [ -s "$DIR/tts/models/shaul.onnx" ] && [ -x "$DIR/tts/src/.venv/bin/python" ] && ok "natural Hebrew voice installed (Phonikud + Piper, runs locally; non-commercial licence)" || warn "the Hebrew voice is incomplete; voice chat falls back to the device voice"
  fi
else ok "skipped — voice chat uses the device's own voice"; fi
if [ "$WITH_STT" = 1 ]; then
  if ! have whisper-cli; then
    echo "  building whisper.cpp (a few minutes)"
    case "$PM" in apt-get) inst git cmake g++ make >/dev/null 2>&1;; dnf) inst git cmake gcc-c++ make >/dev/null 2>&1;; pacman) inst git cmake gcc make >/dev/null 2>&1;; zypper) inst git cmake gcc-c++ make >/dev/null 2>&1;; esac || true
    ( git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp "$TMP/whisper" && cmake -S "$TMP/whisper" -B "$TMP/whisper/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF >/dev/null && cmake --build "$TMP/whisper/build" -j"$CORES" --target whisper-cli >/dev/null && SUDO install -m 755 "$TMP/whisper/build/bin/whisper-cli" /usr/local/bin/whisper-cli ) || warn "building whisper.cpp failed"
  fi
  mkdir -p "$DIR/data/models"; [ -s "$DIR/data/models/ggml-large-v3-turbo-q5_0.bin" ] || curl -fL --retry 3 --progress-bar -o "$DIR/data/models/ggml-large-v3-turbo-q5_0.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin || warn "speech model download failed"
  have whisper-cli && ok "server-side speech recognition installed"
fi

if [ "$NO_SERVICE" = 1 ]; then ok "--no-service: files are installed in $DIR; nothing was started"; exit 0; fi

# ---------------------------------------------------------------- 8. Tailscale + services
step "8/9  Tailscale (the only way in) and services"
if ! have tailscale; then echo "  installing Tailscale"; curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1 || die "could not install Tailscale — install it from https://tailscale.com/download and run this installer again"; fi
SUDO systemctl enable --now tailscaled >/dev/null 2>&1 || true
if ! tailscale status >/dev/null 2>&1; then
  echo "  Connect this machine to YOUR Tailscale network (a free account is enough). Open the link that appears:"
  SUDO tailscale up || die "Tailscale sign-in did not finish"
fi
SUDO tailscale set --operator="$RUN_USER" >/dev/null 2>&1 || true
getent group kvm >/dev/null && SUDO usermod -aG kvm "$RUN_USER" || true

SUDO tee /etc/systemd/system/witbox.service >/dev/null <<EOF
[Unit]
Description=WitBox server (reachable only over your tailnet, via tailscale serve)
After=network-online.target tailscaled.service witbox-vm.service
Wants=network-online.target
[Service]
User=$RUN_USER
WorkingDirectory=$DIR/server
Environment=HOME=$HOME PATH=$DIR/runtime/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$DIR/runtime/node/bin/node index.mjs
Restart=always
RestartSec=3
KillMode=control-group
[Install]
WantedBy=multi-user.target
EOF
SUDO tee /etc/systemd/system/witbox-vm.service >/dev/null <<EOF
[Unit]
Description=WitBox shared computer for the bots (Ubuntu under QEMU/KVM)
After=network.target
ConditionPathExists=$DIR/data/vm_ready
[Service]
User=$RUN_USER
ExecStart=$DIR/vm/run-vm.sh
ExecStop=/bin/sh -c 'echo system_powerdown | socat - unix:$DIR/vm/monitor.sock; sleep 40'
TimeoutStopSec=90
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
# the server may stop/start the shared computer (snapshot and reset from Settings) — and nothing else — without a password
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl stop witbox-vm, /usr/bin/systemctl start witbox-vm, /bin/systemctl stop witbox-vm, /bin/systemctl start witbox-vm\n' "$RUN_USER" | SUDO tee /etc/sudoers.d/witbox >/dev/null
SUDO chmod 440 /etc/sudoers.d/witbox; SUDO visudo -cf /etc/sudoers.d/witbox >/dev/null || { SUDO rm -f /etc/sudoers.d/witbox; warn "sudoers rule rejected; snapshot/reset of the shared computer from the app will not work"; }
SUDO install -m 755 "$DIR/bin/witbox" /usr/local/bin/witbox
SUDO sed -i "s|^WITBOX_DIR=.*|WITBOX_DIR=\"$DIR\"|" /usr/local/bin/witbox
SUDO systemctl daemon-reload
SUDO systemctl enable witbox witbox-vm >/dev/null 2>&1
SUDO systemctl restart witbox
sleep 2
systemctl is-active -q witbox || die "the WitBox service did not start — see: journalctl -u witbox -n 50"
ok "WitBox service is running"
if SUDO tailscale serve --bg "unix:$DIR/data/server.sock" >/dev/null 2>&1; then ok "published to your tailnet only (tailscale serve; Funnel is NOT enabled)"
else warn "tailscale serve failed. Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page), then run:  sudo tailscale serve --bg unix:$DIR/data/server.sock"; fi
URL="https://$(tailscale status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{console.log("<this-machine>.<your-tailnet>.ts.net")}})')"

# ---------------------------------------------------------------- 9. the bots' shared computer
step "9/9  The bots' shared computer"
if [ "$WITH_VM" = 1 ] && [ ! -f "$DIR/data/vm_ready" ]; then
  echo "  Building an Ubuntu desktop machine for the bots (downloads ~600 MB, then 20-40 minutes of setup)."
  echo "  WitBox already works meanwhile: $URL"
  if [ -w /dev/kvm ]; then "$DIR/vm/build-vm.sh" || warn "building the shared computer failed. Try again later with: witbox build-vm"
  else sg kvm -c "$DIR/vm/build-vm.sh" || warn "building the shared computer failed. Log out and in (to join the kvm group), then run: witbox build-vm"; fi
  [ -f "$DIR/data/vm_ready" ] && { SUDO systemctl start witbox-vm; ok "the shared computer is running"; }
elif [ -f "$DIR/data/vm_ready" ]; then SUDO systemctl start witbox-vm 2>/dev/null || true; ok "the shared computer is already built"
else ok "skipped. Build it any time with: witbox build-vm"; fi

printf '\n%s  WitBox %s is installed.%s\n\n' "$c_g" "$(cat "$DIR/VERSION")" "$c_0"
cat <<EOF
  Open it from any device on YOUR Tailscale network:   ${c_b}$URL${c_0}
  Apps (download from that address, after connecting the device to Tailscale):
      Android   $URL/downloads/WitBox.apk
      Windows   $URL/downloads/WitBox-Setup.exe
      Linux     $URL/downloads/witbox-linux-x86_64
  Connectors (Gmail, Calendar, Drive…) come from your Claude account: claude.ai → Settings → Connectors.

  Manage:  witbox status | start | stop | restart | logs | url | login | build-vm | uninstall
  WitBox is not reachable from the internet — only from devices signed in to your tailnet as you.
EOF
