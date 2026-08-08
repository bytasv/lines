#!/usr/bin/env bash
#
# Lines backup — nightly via lines-backup.timer, or `systemctl start
# lines-backup.service` by hand.
#
# ~/.lines-app is the source of truth: sync.ts treats the local flat JSON as
# authoritative and Postgres as a best-effort mirror. Losing this directory
# loses transcripts, attachments, Claude OAuth tokens and guard allowlists.
# Supabase will not save you.
#
# Prerequisites:
#   - a passphrase in $PASSPHRASE_FILE, mode 600 (the archive holds live Claude
#     OAuth refresh tokens, so it is never stored or uploaded in the clear)
#   - an rclone remote named $RCLONE_REMOTE pointing at R2
#   - the same narrow sudo rule deploy.sh uses (systemctl restart lines-*)
set -euo pipefail

STORE_DIR="${STORE_DIR:-/home/lines/.lines-app}"
BACKUP_DIR="${BACKUP_DIR:-/home/lines/backups}"
PASSPHRASE_FILE="${PASSPHRASE_FILE:-/home/lines/.config/lines-backup.passphrase}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
RCLONE_PATH="${RCLONE_PATH:-lines-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/lines-app-$STAMP.tar.gz"
ENCRYPTED="$ARCHIVE.gpg"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ ! -r "$PASSPHRASE_FILE" ]; then
  echo "FATAL: no passphrase at $PASSPHRASE_FILE — refusing to write a plaintext backup." >&2
  exit 1
fi

bridge_was_active=no
if systemctl is-active --quiet lines-bridge; then
  bridge_was_active=yes
fi

restore_bridge() {
  if [ "$bridge_was_active" = yes ] && ! systemctl is-active --quiet lines-bridge; then
    sudo systemctl start lines-bridge
  fi
}
trap restore_bridge EXIT

# Stop the bridge for the tar: sessions.json is rewritten whole, so a snapshot
# taken mid-write is a torn file.
if [ "$bridge_was_active" = yes ]; then
  sudo systemctl stop lines-bridge
fi

# run/ is regenerated on boot (discovery files); plugins/ is re-cloned by
# caveman.ts. Neither is worth the bytes and both churn constantly.
tar czf "$ARCHIVE" \
  --exclude='./run' \
  --exclude='./plugins' \
  -C "$STORE_DIR" .

if [ "$bridge_was_active" = yes ]; then
  sudo systemctl start lines-bridge
fi
trap - EXIT

gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$PASSPHRASE_FILE" \
    --output "$ENCRYPTED" "$ARCHIVE"
rm -f "$ARCHIVE"
chmod 600 "$ENCRYPTED"

rclone copy "$ENCRYPTED" "$RCLONE_REMOTE:$RCLONE_PATH/"

find "$BACKUP_DIR" -name 'lines-app-*.tar.gz.gpg' -mtime "+$RETENTION_DAYS" -delete

echo "backup complete: $ENCRYPTED -> $RCLONE_REMOTE:$RCLONE_PATH/"
echo "reminder: 'tar tzf' is not a restore test. Restore into a scratch dir and"
echo "boot a throwaway LINES_INSTANCE against it once a quarter."
