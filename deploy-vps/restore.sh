#!/usr/bin/env bash
# Put a database backup (made by backup.sh, or `pg_dump -Fc` on the old host) into this server's database. REPLACES what is there.
#
#   sudo /opt/glm-pos/deploy-vps/restore.sh /root/glm_pos.dump
#
# The API is stopped while it runs. Afterwards run update.sh, which brings the tables up to date with the latest code and starts the API.
set -euo pipefail

ENV_FILE=/etc/glm-pos/api.env
FILE="${1:-}"
[ "$(id -u)" = 0 ] || { echo "Run this as root: sudo $0 <dump file>"; exit 1; }
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Usage: sudo $0 <path to a .dump file>"; exit 1; }

set -a; . "$ENV_FILE"; set +a

echo "This will REPLACE the contents of the database on this server with: $FILE"
read -r -p "Type YES to continue: " answer
[ "$answer" = "YES" ] || { echo "Cancelled — nothing was changed."; exit 1; }

systemctl stop glm-pos-api 2>/dev/null || true

# --clean --if-exists drops each object before recreating it, so this works on an empty database and on one that already has tables.
# (Warnings about roles or extensions that do not exist here are normal and harmless.)
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$FILE" || {
  echo "pg_restore reported problems (see above). If they are only warnings about roles/extensions the data is still restored."
}

echo "Table count after restore:"
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
echo "Restored. Now run:  sudo $(dirname "$0")/update.sh"
