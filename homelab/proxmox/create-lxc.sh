#!/usr/bin/env bash
# Run on the Proxmox host. Creates an unprivileged Debian LXC ready for Docker
# (nesting + keyctl), then runs bootstrap.sh inside it.
#
#   REPO_URL=https://github.com/<you>/openGym.git ./create-lxc.sh
#
# Optional: DEBIAN_RELEASE (12 on Proxmox 8, 13 on Proxmox 9), CTID, CT_HOSTNAME,
# TEMPLATE_STORAGE, ROOTFS_STORAGE, DISK_GB, CORES, MEMORY, BRIDGE,
# BACKUP_HOST_DIR (a host directory bind-mounted at /var/backups/opengym for the nightly
# archive; in an unprivileged CT it has to be writable by host uid 100000).
set -euo pipefail

REPO_URL=${REPO_URL:?set REPO_URL to your fork, e.g. https://github.com/<you>/openGym.git}
DEBIAN_RELEASE=${DEBIAN_RELEASE:-$(pveversion | grep -q 'pve-manager/8' && echo 12 || echo 13)}
CTID=${CTID:-$(pvesh get /cluster/nextid)}
CT_HOSTNAME=${CT_HOSTNAME:-opengym}
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}
ROOTFS_STORAGE=${ROOTFS_STORAGE:-local-lvm}
DISK_GB=${DISK_GB:-8}
CORES=${CORES:-2}
MEMORY=${MEMORY:-1024}
BRIDGE=${BRIDGE:-vmbr0}
BACKUP_HOST_DIR=${BACKUP_HOST_DIR:-}
HERE=$(cd "$(dirname "$0")" && pwd)

pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk -v t="debian-$DEBIAN_RELEASE-standard" '$2 ~ t {print $2}' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || { echo "No debian-$DEBIAN_RELEASE-standard template offered by pveam" >&2; exit 1; }
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

echo "Creating CT $CTID ($CT_HOSTNAME) from $TEMPLATE"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "$ROOTFS_STORAGE:$DISK_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --onboot 1

if [ -n "$BACKUP_HOST_DIR" ]; then
  pct set "$CTID" --mp0 "$BACKUP_HOST_DIR,mp=/var/backups/opengym"
fi

pct start "$CTID"
for _ in $(seq 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

pct push "$CTID" "$HERE/bootstrap.sh" /root/bootstrap.sh --perms 755
pct exec "$CTID" -- env REPO_URL="$REPO_URL" /root/bootstrap.sh

echo
echo "CT $CTID ready. Enter it with: pct enter $CTID"
