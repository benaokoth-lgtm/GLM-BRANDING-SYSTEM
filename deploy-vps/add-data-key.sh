#!/usr/bin/env bash
# Give the GLM POS a DATA_KEY: the key that seals saved secrets (M-Pesa, email, Google Drive) in the database and encrypts every backup file.
#
#   sudo /opt/glm-pos/deploy-vps/add-data-key.sh
#
# It adds a random key to /etc/glm-pos/api.env (once — if there is one already it does nothing), shows it to you ONCE, and restarts the app.
# Copy the key into a password manager straight away: without it, encrypted backups and sealed settings cannot be opened, and the server
# is the only other place it is kept. Do not paste it into chat or email.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/glm-pos/api.env}"
SERVICE="${SERVICE:-glm-pos-api}"

fail() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root: sudo $0"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found."
command -v openssl >/dev/null || fail "openssl is needed to make the key."

if grep -qE '^DATA_KEY=.{16,}' "$ENV_FILE"; then
  echo "A DATA_KEY is already set in $ENV_FILE — nothing changed."
  echo "(To see it: sudo grep ^DATA_KEY= $ENV_FILE)"
  exit 0
fi

KEY="$(openssl rand -hex 32)"
cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
# keep the file's owner and permissions; drop any empty DATA_KEY= line first
sed -i '/^DATA_KEY=/d' "$ENV_FILE"
printf 'DATA_KEY=%s\n' "$KEY" >> "$ENV_FILE"

systemctl restart "$SERVICE"
sleep 3
if curl -fsS http://127.0.0.1:"$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | head -1)"/api/health >/dev/null 2>&1; then
  echo "The app restarted and is healthy."
else
  echo "The app was restarted — check it with: sudo systemctl status $SERVICE"
fi

cat <<DONE

================================================================
  YOUR DATA KEY (shown once — copy it into a password manager now):

  $KEY

================================================================
Saved secrets are sealed with it the first time the app starts, and every new backup is encrypted with it.
Old backup files made before this stay as they were (readable); new ones are encrypted.
If you ever move to a new server, put this same DATA_KEY in its api.env BEFORE restoring a backup.
DONE
