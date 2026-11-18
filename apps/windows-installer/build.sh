#!/usr/bin/env bash
# Builds the WitBox Windows installer -> <repo>/downloads/WitBox-Setup.exe
#
# Needs: makensis (NSIS 3), python3 + Pillow, and the Windows app already built
# (apps/desktop/build.sh -> downloads/WitBox-windows-x64.exe).
#
# The optional "WitBox server on this PC (WSL2)" component is included only when all of
#   install-server.ps1  install.sh  witbox-linux-x86_64.tar.gz
# exist in <repo>/dist/ (override with SERVER_DIR=...). Re-run this script after adding them.
#
# Environment: OUT (output dir), APP_EXE, SERVER_DIR, ARCH (x86-unicode | amd64-unicode),
#              OUTFILE (full output path).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$ROOT/downloads}"
APP_EXE="${APP_EXE:-$OUT/WitBox-windows-x64.exe}"
SERVER_DIR="${SERVER_DIR:-$ROOT/dist}"
ARCH="${ARCH:-x86-unicode}"
OUTFILE="${OUTFILE:-$OUT/WitBox-Setup.exe}"
BUILD="$HERE/build"
ICON="$ROOT/assets/icon.ico"
VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/apps/desktop/Cargo.toml" | head -n1)"

command -v makensis >/dev/null || { echo "makensis not found (apt install nsis)" >&2; exit 1; }
[ -f "$APP_EXE" ] || { echo "missing $APP_EXE - run apps/desktop/build.sh first" >&2; exit 1; }
[ -f "$ICON" ] || { echo "missing $ICON" >&2; exit 1; }
[ -n "$VERSION" ] || { echo "cannot read the version from apps/desktop/Cargo.toml" >&2; exit 1; }

mkdir -p "$BUILD" "$(dirname "$OUTFILE")"
python3 "$HERE/make_bitmaps.py" "$BUILD"

args=(-V2 -INPUTCHARSET UTF8
  "-DVERSION=$VERSION" "-DARCH=$ARCH" "-DAPP_EXE=$APP_EXE" "-DICON=$ICON"
  "-DWELCOME_BMP=$BUILD/welcome.bmp" "-DHEADER_BMP=$BUILD/header.bmp" "-DOUTFILE=$OUTFILE")

server=yes
for f in install-server.ps1 install.sh witbox-linux-x86_64.tar.gz; do
  [ -f "$SERVER_DIR/$f" ] || { server=no; missing="${missing:-} $f"; }
done
if [ "$server" = yes ]; then
  args+=("-DSERVER_DIR=$SERVER_DIR")
  echo "server component: included (from $SERVER_DIR)"
else
  echo "server component: NOT included (missing in $SERVER_DIR:${missing})"
fi

rm -f "$OUTFILE"
makensis "${args[@]}" "$HERE/witbox.nsi"
[ -s "$OUTFILE" ] || { echo "makensis produced no output" >&2; exit 1; }
echo "built $OUTFILE ($(stat -c %s "$OUTFILE") bytes, $(du -h "$OUTFILE" | cut -f1)) - WitBox $VERSION, $ARCH"
