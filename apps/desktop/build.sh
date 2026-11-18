#!/usr/bin/env bash
# Builds both WitBox desktop binaries and copies them to ../../downloads/.
#
# Requirements (Debian/Ubuntu):
#   rustup toolchain + `rustup target add x86_64-pc-windows-gnu`
#   apt: mingw-w64 libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
OUT="${OUT:-../../downloads}"
mkdir -p "$OUT"

# Keep the builder's home directory / user name out of the binaries (panic messages embed
# source paths). The Windows flags repeat .cargo/config.toml because the env var replaces it.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
REMAP="--remap-path-prefix=$CARGO_HOME_DIR=cargo --remap-path-prefix=$PWD=witbox --remap-path-prefix=$(rustc --print sysroot)=rust --remap-path-prefix=$HOME=~"
HOST="$(rustc -vV | awk '/^host:/{print $2}')"
host_var="CARGO_TARGET_$(echo "$HOST" | tr 'a-z-' 'A-Z_')_RUSTFLAGS"
export "$host_var=$REMAP"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="$REMAP -C target-feature=+crt-static -C link-arg=-static -C link-arg=-static-libgcc"

cargo test --release --quiet
cargo build --release
cargo build --release --target x86_64-pc-windows-gnu

install -m 755 target/release/witbox "$OUT/witbox-linux-x86_64"
install -m 644 target/x86_64-pc-windows-gnu/release/witbox.exe "$OUT/WitBox-windows-x64.exe"

echo "== Windows imports (must be system DLLs only) =="
x86_64-w64-mingw32-objdump -p "$OUT/WitBox-windows-x64.exe" | awk '/DLL Name/{print tolower($3)}' | sort -u | tr '\n' ' '; echo
if x86_64-w64-mingw32-objdump -p "$OUT/WitBox-windows-x64.exe" | grep -Eiq 'DLL Name: (libgcc|libwinpthread|libstdc|WebView2Loader)'; then
  echo "ERROR: unexpected non-system DLL import" >&2; exit 1
fi
for f in "$OUT/witbox-linux-x86_64" "$OUT/WitBox-windows-x64.exe"; do
  if grep -aq -e "$HOME/" "$f"; then
    echo "ERROR: $f embeds paths below $HOME" >&2; exit 1
  fi
done
echo "== Linux direct dependencies =="
readelf -d "$OUT/witbox-linux-x86_64" | awk '/NEEDED/{print $5}' | tr -d '[]' | tr '\n' ' '; echo
ls -la "$OUT/witbox-linux-x86_64" "$OUT/WitBox-windows-x64.exe"
