#!/usr/bin/env bash
# Met a jour le serveur LiveChat sur le VPS et redemarre le service.
# A lancer depuis /opt/livechat (ou adapte le chemin ci-dessous).
set -euo pipefail

cd "$(dirname "$0")/.."

git pull
npm install --omit=dev
sudo systemctl restart livechat

echo "LiveChat redemarre : $(git log -1 --format='%h %s')"
