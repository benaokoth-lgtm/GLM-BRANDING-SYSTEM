#!/usr/bin/env bash
# Dump the database to /var/backups/glm-pos (compressed, restorable with restore.sh) and keep the last 30 days.
# Runs every night from /etc/cron.d/glm-pos-backup and at the start of every update.sh.
#
# Off-server copy (strongly recommended — a backup on the same machine is lost with the machine): install rclone, set up a remote
# (Contabo Object Storage, Google Drive, another server …) and put its name in /etc/glm-pos/backup.conf as
#   OFFSITE_REMOTE=myremote:glm-pos-backups
# Every dump is then copied there too.
set -euo pipefail

ENV_FILE=/etc/glm-pos/api.env
CONF=/etc/glm-pos/backup.conf
DEST=/var/backups/glm-pos
KEEP_DAYS=30

set -a; . "$ENV_FILE"; set +a
[ -f "$CONF" ] && . "$CONF"

mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DEST/glm_pos-$STAMP.dump"

pg_dump --format=custom --no-owner "$DATABASE_URL" > "$FILE.partial"
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"
echo "$(date '+%F %T') backup written: $FILE ($(du -h "$FILE" | cut -f1))"

find "$DEST" -name 'glm_pos-*.dump' -mtime +"$KEEP_DAYS" -delete

if [ -n "${OFFSITE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null; then
    rclone copy "$FILE" "$OFFSITE_REMOTE" && echo "copied off the server to $OFFSITE_REMOTE"
  else
    echo "OFFSITE_REMOTE is set but rclone is not installed — the copy was NOT made." >&2
  fi
fi
