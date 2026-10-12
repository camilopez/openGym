#!/usr/bin/env bash
# Run inside the LXC (create-lxc.sh does it). Installs Docker from Docker's own apt repo,
# clones the fork, lays out .env and the Tailscale key file, and schedules the nightly backup.
# Safe to re-run: nothing that already exists is overwritten.
set -euo pipefail

REPO_URL=${REPO_URL:?set REPO_URL to your fork}
APP_DIR=${APP_DIR:-/opt/opengym}
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

[ -d "$APP_DIR/.git" ] || git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
[ -f .env ] || cp homelab/env.homelab.example .env
[ -f homelab/tailscale.env ] || cp homelab/tailscale.env.example homelab/tailscale.env
chmod 600 .env homelab/tailscale.env

cat > /etc/cron.d/opengym-backup <<EOF
30 3 * * * root $APP_DIR/homelab/backup.sh >> /var/log/opengym-backup.log 2>&1
EOF

cat <<EOF

Docker $(docker --version | awk '{print $3}' | tr -d ,) and openGym are in $APP_DIR. Next:
  1. Check RP_ID / ORIGIN in $APP_DIR/.env (opengym.<tailnet>.ts.net)
  2. cd $APP_DIR && docker compose pull && docker compose up -d
  3. docker compose logs tailscale   # open the login URL it prints, approve the machine
EOF
