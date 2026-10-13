#!/usr/bin/env bash
# Deploys the fork's frontend to the homelab: builds it here, ships dist/ to the LXC, builds
# opengym-web-fork:<commit> there on top of the released web image (homelab/web-fork/Dockerfile)
# and points the web service at it (OPENGYM_WEB_IMAGE in the LXC's .env). The api keeps running
# the release image: the fork changes the frontend only.
#
#   homelab/deploy-web.sh
#
# Run from a clean checkout whose HEAD is pushed to origin: the LXC pulls the same commit, so
# the compose overlay and the app it serves come from one revision. Takes a backup first.
# Back to the release image: delete OPENGYM_WEB_IMAGE from the LXC's .env, docker compose up -d.
set -euo pipefail

PVE=${PVE:-root@192.168.68.20}
CTID=${CTID:-105}
APP_DIR=${APP_DIR:-/opt/opengym}

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || { echo "the working tree has changes: commit them first" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD)
git fetch -q origin
git merge-base --is-ancestor HEAD origin/main || { echo "$SHA is not on origin/main: push it first" >&2; exit 1; }

echo "→ building the frontend ($SHA)"
(cd frontend && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && APP_BUILD="fork.$SHA" npm run build >/dev/null)
TAR=$(mktemp -t opengym-web.XXXXXX).tgz
trap 'rm -f "$TAR"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TAR" -C frontend dist   # no macOS metadata for GNU tar to warn about

echo "→ shipping it to CT $CTID"
scp -q "$TAR" "$PVE:/tmp/opengym-web.tgz"
ssh "$PVE" "pct push $CTID /tmp/opengym-web.tgz /tmp/opengym-web.tgz && rm /tmp/opengym-web.tgz"

echo "→ backup, pull, build, restart"
ssh "$PVE" "pct exec $CTID -- bash -s" <<EOF
set -euo pipefail
cd $APP_DIR
/opt/opengym/homelab/backup.sh
git pull -q --ff-only
[ "\$(git rev-parse --short HEAD)" = "$SHA" ] || { echo "the LXC is at \$(git rev-parse --short HEAD), not $SHA" >&2; exit 1; }
rm -rf homelab/web-fork/dist && tar -xzf /tmp/opengym-web.tgz -C homelab/web-fork && rm /tmp/opengym-web.tgz
VERSION=\$(sed -n 's/^OPENGYM_VERSION=//p' .env)
docker build -q --build-arg BASE=ghcr.io/duartesantos8/opengym-web:\$VERSION --build-arg VCS_REF=$SHA \
  -t opengym-web-fork:\$VERSION-$SHA homelab/web-fork
if grep -q '^OPENGYM_WEB_IMAGE=' .env; then
  sed -i "s|^OPENGYM_WEB_IMAGE=.*|OPENGYM_WEB_IMAGE=opengym-web-fork:\$VERSION-$SHA|" .env
else
  printf '\n# The fork frontend (homelab/deploy-web.sh). Delete to go back to the release image.\nOPENGYM_WEB_IMAGE=opengym-web-fork:%s\n' "\$VERSION-$SHA" >> .env
fi
docker compose up -d web
docker compose ps web
EOF
echo "✓ web is opengym-web-fork:$SHA"
