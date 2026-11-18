#!/usr/bin/env bash
# Installs the full edition (with device control) on a phone over Tailscale using wireless debugging.
# Phone: Settings > Developer options > Wireless debugging > "Pair device with pairing code".
# Usage: ./install-full.sh <phone-tailscale-ip> <pair-port> <pairing-code> <connect-port>
# adb is taken from $ADB, else from PATH, else from $ANDROID_HOME or ~/Android/Sdk.
set -e
if [ "$#" -ne 4 ]; then
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
if [ -z "${ADB:-}" ]; then
  if command -v adb >/dev/null 2>&1; then
    ADB="$(command -v adb)"
  else
    ADB="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}/platform-tools/adb"
  fi
fi
if [ ! -x "$ADB" ]; then
  echo "adb not found ($ADB). Install Android platform-tools or set ADB=/path/to/adb." >&2
  exit 1
fi
APK="$(dirname "$0")/../../downloads/WitBox-full.apk"
"$ADB" pair "$1:$2" "$3"
"$ADB" connect "$1:$4"
"$ADB" -s "$1:$4" install -r "$APK"
"$ADB" disconnect "$1:$4"
