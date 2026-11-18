#!/usr/bin/env bash
# Builds the release files into dist/:
#   witbox-linux-x86_64.tar.gz   the whole server + web UI + the client apps, one file
#   install.sh                   Linux installer (run it next to the tarball)
#   install-server.ps1           Windows (WSL2) server installer
#   WitBox-Setup.exe             Windows installer for the app (and, optionally, the server files)
#   WitBox.apk  WitBox-full.apk  WitBox-windows-x64.exe  witbox-linux-x86_64   the client apps on their own
# Build the apps first: apps/android/build.sh, apps/desktop/build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
VER="$(cat VERSION)"; DIST="$ROOT/dist"; STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
rm -rf "$DIST"; mkdir -p "$DIST" "$STAGE/witbox/downloads"
for f in WitBox.apk WitBox-full.apk WitBox-windows-x64.exe witbox-linux-x86_64; do [ -f "downloads/$f" ] || { echo "missing downloads/$f — build the apps first" >&2; exit 1; }; done

pack() { # copies the installable tree into $STAGE/witbox
  tar -cf - --exclude=node_modules --exclude='*.qcow2' --exclude='*.img' --exclude='*.iso' --exclude='*.sock' --exclude='*.log' --exclude='*.ppm' \
      server web assets vm bin docs tts/server.py VERSION LICENSE README.md README.he.md install.sh | tar -xf - -C "$STAGE/witbox"
  cp downloads/WitBox.apk downloads/WitBox-full.apk downloads/WitBox-windows-x64.exe downloads/witbox-linux-x86_64 "$STAGE/witbox/downloads/"
}
mk() { tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$DIST/witbox-linux-x86_64.tar.gz" witbox; }

pack; mk                                   # first pass: the tarball that goes inside the Windows installer
cp install.sh packaging/install-server.ps1 "$DIST/"
apps/windows-installer/build.sh >/dev/null # WitBox-Setup.exe now carries the server files (install.sh + tarball + ps1)
cp downloads/WitBox-Setup.exe "$STAGE/witbox/downloads/"
mk                                         # final tarball, serving the complete Windows installer from the server too
cp downloads/WitBox.apk downloads/WitBox-full.apk downloads/WitBox-windows-x64.exe downloads/witbox-linux-x86_64 downloads/WitBox-Setup.exe "$DIST/"
( cd "$DIST" && sha256sum * > SHA256SUMS )
echo "WitBox $VER release files:"; ls -la "$DIST"
