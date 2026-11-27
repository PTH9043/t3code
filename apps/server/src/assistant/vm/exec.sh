#!/bin/sh
set -eu
cd /home/t3vm
test -f id_ed25519 || { echo 'VM is still starting' >&2; exit 1; }
exec ssh -i id_ed25519 -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/t3vm/known_hosts -p 2222 t3user@127.0.0.1 "$@"
