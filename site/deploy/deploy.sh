#!/usr/bin/env bash
# Publishes the website to the VPS.  usage: site/deploy/deploy.sh user@host
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host}"; HERE="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$HERE/build.py"
rsync -az --delete -e "ssh -o IPQoS=none" --exclude build.py --exclude deploy --exclude '__pycache__' "$HERE/" "$HOST:/var/www/witbox/"
echo "published to $HOST:/var/www/witbox"
