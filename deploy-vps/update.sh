#!/usr/bin/env bash
# Deploy the latest code — the VPS equivalent of "Update from Remote → Deploy HEAD Commit" on cPanel, plus the database update and restart.
#
#   sudo /opt/glm-pos/deploy-vps/update.sh
#
# Order: back up the database → pull the latest commit → install the runtime packages → generate the Prisma client → update the tables
# (additive changes only; anything that would delete data stops here instead) → copy the web files → restart the API → check it answers.
set -euo pipefail

APP_DIR=/opt/glm-pos
ENV_FILE=/etc/glm-pos/api.env

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run this as root: sudo $0"; exit 1; }

set -a; . "$ENV_FILE"; set +a

say "Backing up the database first"
"$APP_DIR/deploy-vps/backup.sh"

say "Pulling the latest code"
sudo -u glm git -C "$APP_DIR" pull --ff-only

say "Runtime packages and Prisma client"
sudo -u glm bash -c "cd '$APP_DIR/deploy/api' && npm install --omit=dev && npx prisma generate --schema=prisma/schema.prisma"

say "Updating the database tables"
# No --accept-data-loss: if a change would drop data this fails and nothing is changed — tell me what it printed.
sudo -u glm env DATABASE_URL="$DATABASE_URL" bash -c "cd '$APP_DIR/deploy/api' && npx prisma db push --schema=prisma/schema.prisma --skip-generate"

say "Web files"
rsync -a --delete "$APP_DIR/deploy/web/" /var/www/pos/

say "Restarting the API"
systemctl restart glm-pos-api

say "Health check"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT:-4100}/api/health" >/dev/null 2>&1; then
    echo "API is up."
    git -C "$APP_DIR" log -1 --format='Running commit %h — %s'
    exit 0
  fi
  sleep 1
done
echo "The API did not answer within 20 seconds. Look at:  journalctl -u glm-pos-api -n 60 --no-pager"
exit 1
