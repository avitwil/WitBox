#!/bin/bash
# Builds the bots' shared computer from the official Ubuntu Server 24.04 cloud image:
# downloads the image, creates the disk, generates the admin password and SSH key, and lets cloud-init
# install the XFCE desktop, xrdp, Chrome, Firefox and LibreOffice on the first boot (20-40 minutes).
# Usage: build-vm.sh [--force]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
DATA="${WITBOX_DATA:-$HERE/../data}"; mkdir -p "$DATA"
[ -f "$DATA/config.env" ] && . "$DATA/config.env"
DISK="${VM_DISK:-ubuntu.qcow2}"; SSH_PORT="${VM_SSH_PORT:-10022}"
IMG_URL="${VM_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
say() { printf '\033[1;36m[vm]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[vm] %s\033[0m\n' "$*" >&2; exit 1; }

if [ -f "$DISK" ] && [ -f "$DATA/vm_ready" ] && [ "${1:-}" != "--force" ]; then say "the shared computer is already built ($DISK). Use --force to rebuild it from scratch."; exit 0; fi
for b in qemu-system-x86_64 qemu-img xorriso ssh ssh-keygen openssl curl; do command -v "$b" >/dev/null || die "missing program: $b"; done
[ -w /dev/kvm ] || die "/dev/kvm is not usable by $(id -un). Enable virtualization (VT-x/AMD-V) in the BIOS, and make sure you are in the 'kvm' group (log out and in after the installer adds you)."
if pgrep -f "name ${VM_NAME:-witbox-pc}( |$)" >/dev/null; then die "the shared computer is running; stop it first (sudo systemctl stop witbox-vm)"; fi

say "admin password and SSH key"
[ -f "$DATA/vm_key" ] || ssh-keygen -q -t ed25519 -N '' -C witbox -f "$DATA/vm_key"
[ -f "$DATA/vm_admin_pass" ] || ( umask 077; openssl rand -base64 15 | tr -d '/+=' | cut -c1-16 > "$DATA/vm_admin_pass" )
chmod 600 "$DATA/vm_key" "$DATA/vm_admin_pass"
HASH="$(openssl passwd -6 "$(cat "$DATA/vm_admin_pass")")"
TZN="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"; [ -n "$TZN" ] || TZN=UTC

say "downloading Ubuntu Server 24.04 cloud image (about 600 MB)"
curl -fL --retry 3 -C - -o base.img.part "$IMG_URL" && mv base.img.part base.img
say "creating the disk (${VM_DISK_GB:-80} GB, grows on demand)"
rm -f "$DISK" "$DATA/vm_ready"
qemu-img convert -O qcow2 base.img "$DISK"
qemu-img resize -q "$DISK" "${VM_DISK_GB:-80}G"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
awk -v h="$HASH" -v k="$(cat "$DATA/vm_key.pub")" -v z="$TZN" '{ gsub(/@PASSWD_HASH@/, h); gsub(/@SSH_PUBKEY@/, k); gsub(/@TIMEZONE@/, z); print }' seed/user-data.in > "$T/user-data"
cp seed/meta-data "$T/meta-data"
xorriso -as mkisofs -quiet -o "$T/seed.iso" -V cidata -J -r "$T/user-data" "$T/meta-data"

say "first boot: installing the desktop and apps inside the computer (20-40 minutes, needs internet)"
./run-vm.sh -drive file="$T/seed.iso",if=virtio,media=cdrom,readonly=on >"$HERE/vm.log" 2>&1 &
QPID=$!
SSH=(ssh -i "$DATA/vm_key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=8 cbadmin@127.0.0.1)
start=$(date +%s); last=""
while :; do
  kill -0 "$QPID" 2>/dev/null || die "QEMU exited unexpectedly — see $HERE/vm.log"
  if "${SSH[@]}" 'test -f /var/lib/witbox-ready' 2>/dev/null; then break; fi
  now=$(date +%s); [ $((now - start)) -gt 5400 ] && { kill "$QPID" 2>/dev/null; die "timed out after 90 minutes — see /var/log/cloud-init-output.log inside the VM"; }
  line="$("${SSH[@]}" 'tail -n 1 /var/log/cloud-init-output.log' 2>/dev/null | cut -c1-90 || true)"
  [ -n "$line" ] && [ "$line" != "$last" ] && { say "$(( (now - start) / 60 )) min · $line"; last="$line"; }
  sleep 20
done
"${SSH[@]}" 'command -v google-chrome >/dev/null && systemctl is-enabled xrdp >/dev/null' || say "warning: Chrome or xrdp did not install cleanly; check /var/log/cloud-init-output.log in the VM"
say "shutting down and saving the clean snapshot"
"${SSH[@]}" 'sudo poweroff' 2>/dev/null || true
for _ in $(seq 60); do kill -0 "$QPID" 2>/dev/null || break; sleep 2; done
kill "$QPID" 2>/dev/null || true; sleep 1
qemu-img snapshot -c clean "$DISK"
rm -f base.img
touch "$DATA/vm_ready"
say "done. The shared computer is ready (admin user: cbadmin, password in $DATA/vm_admin_pass)."
