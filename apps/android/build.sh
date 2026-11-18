#!/usr/bin/env bash
# Builds both WitBox Android editions (release) and copies them to ../../downloads/:
#   WitBox.apk       standard edition
#   WitBox-full.apk  full edition (adds the accessibility service for device control)
#
# Needs the Android SDK (platform 35, build-tools 35.0.0) in $ANDROID_HOME (default
# ~/Android/Sdk) and JDK 17-21. Signing: keystore.properties if present, else the debug key.
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
# Gradle 8 needs JDK 17-21; use JDK 21 when the default java is newer
if [ -z "${JAVA_HOME:-}" ]; then for j in /usr/lib/jvm/java-21-openjdk-amd64 /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-21; do [ -d "$j" ] && { export JAVA_HOME="$j"; break; }; done; fi
OUT="${OUT:-../../downloads}"
mkdir -p "$OUT"

./gradlew --console=plain assembleStandardRelease assembleFullRelease

BT="$ANDROID_HOME/build-tools/35.0.0"
for pair in standard:WitBox.apk full:WitBox-full.apk; do
  flavor="${pair%%:*}"; name="${pair##*:}"
  apk="$(ls app/build/outputs/apk/$flavor/release/*.apk | head -n1)"
  install -m 644 "$apk" "$OUT/$name"
  "$BT/apksigner" verify "$OUT/$name"
  "$BT/aapt2" dump badging "$OUT/$name" | grep -E "^(package|application-label):"
done
if "$BT/aapt2" dump xmltree --file AndroidManifest.xml "$OUT/WitBox.apk" | grep -q AccessibilityService; then
  echo "ERROR: the standard edition must not declare an accessibility service" >&2; exit 1
fi
ls -la "$OUT/WitBox.apk" "$OUT/WitBox-full.apk"
