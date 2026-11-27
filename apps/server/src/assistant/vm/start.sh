#!/bin/sh
set -eu
cd /home/t3vm
umask 077
if [ ! -f disk.qcow2 ]; then
  qemu-img create -f qcow2 -F qcow2 -b /opt/t3-vm/ubuntu.qcow2 disk.qcow2 16G
fi
if [ ! -f id_ed25519 ]; then
  ssh-keygen -q -t ed25519 -N '' -f id_ed25519
fi
if [ ! -f seed.iso ]; then
  key=$(cat id_ed25519.pub)
  cat > user-data <<EOF
#cloud-config
users:
  - name: t3user
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $key
ssh_pwauth: false
disable_root: true
EOF
  printf 'instance-id: t3-assistant-vm\nlocal-hostname: t3-assistant\n' > meta-data
  cloud-localds seed.iso user-data meta-data
  rm -f user-data meta-data
fi
exec qemu-system-x86_64 -machine q35,accel=tcg -cpu max -smp 2 -m 4096 \
  -drive file=disk.qcow2,format=qcow2,if=virtio -drive file=seed.iso,format=raw,if=virtio,readonly=on \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 \
  -display none -monitor none -serial none -no-reboot
