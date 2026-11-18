#!/bin/bash
# WitBox shared computer: Ubuntu Server 24.04 + XFCE under QEMU/KVM. Reachable from the host only (127.0.0.1).
# Size comes from data/config.env (VM_RAM_GB, VM_CPUS), written by the installer. Extra arguments go to QEMU.
cd "$(dirname "$0")"
DATA="${WITBOX_DATA:-../data}"
[ -f "$DATA/config.env" ] && . "$DATA/config.env"
CPUS="${VM_CPUS:-6}"; RAM="${VM_RAM_GB:-16}"
exec qemu-system-x86_64 -name "${VM_NAME:-witbox-pc}" -enable-kvm -machine q35 -cpu host \
 -smp "$CPUS",sockets=1,cores="$CPUS",threads=1 -m "${RAM}G" \
 -drive file="${VM_DISK:-ubuntu.qcow2}",if=virtio,format=qcow2,cache=writeback,discard=unmap \
 -netdev user,id=n0,hostfwd=tcp:127.0.0.1:"${VM_RDP_PORT:-13389}"-:3389,hostfwd=tcp:127.0.0.1:"${VM_SSH_PORT:-10022}"-:22 -device virtio-net-pci,netdev=n0 \
 -device virtio-rng-pci -vga std -vnc 127.0.0.1:"${VM_VNC_DISPLAY:-50}" -usb -device usb-tablet \
 -monitor unix:"${VM_MONITOR:-monitor.sock}",server,nowait -display none "$@"
