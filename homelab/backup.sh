#!/usr/bin/env bash
# Nightly archive of ./data (every profile, passkey, workout and the session secret), keeping
# the newest $KEEP. bootstrap.sh schedules it at 03:30 via /etc/cron.d/opengym-backup.
# Every save in the API is write-temp-then-rename, so archiving a running instance is safe.
set -euo pipefail

cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-/var/backups/opengym}
KEEP=${KEEP:-14}

mkdir -p "$DEST"
out="$DEST/opengym-$(date +%F-%H%M).tar.gz"
tar czf "$out.tmp" data/
mv "$out.tmp" "$out"

ls -1t "$DEST"/opengym-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "$(date -Is) $out ($(du -h "$out" | cut -f1))"
