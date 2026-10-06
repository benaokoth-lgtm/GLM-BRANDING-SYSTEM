#!/usr/bin/env bash
# Set up the GLM Branding POS on a server that ALREADY runs other applications (Caddy on ports 80/443, PostgreSQL, Node, pm2 apps …).
#
#   sudo bash /opt/glm-pos/deploy-vps/setup-server.sh
#
# It adds this system next to what is already there and changes nothing of the others: no package upgrades, no firewall changes, no
# time-zone change, no second web server. It creates a separate database and a locked-down service user, writes the settings file (with
# freshly generated secrets), installs the systemd service (not started yet), the nightly backup, and a Caddy snippet that is NOT switched on
# until cutover day (enable-site.sh). Safe to run again: it never overwrites existing secrets.
set -euo pipefail

WEB_HOST="${WEB_HOST:-pos.glmgroup.co.ke}"
API_HOST="${API_HOST:-api.glmgroup.co.ke}"
API_PORT="${API_PORT:-4100}"
# The repository is private, so it is reached over SSH with a read-only deploy key kept at /etc/glm-pos/deploy_key (see DEPLOYMENT-VPS.md, A3).
REPO_URL="${REPO_URL:-git@github.com:benaokoth-lgtm/GLM-BRANDING-SYSTEM.git}"
APP_DIR=/opt/glm-pos
ENV_DIR=/etc/glm-pos
ENV_FILE="$ENV_DIR/api.env"
DEPLOY_KEY="$ENV_DIR/deploy_key"
GIT_SSH="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
DB_NAME=glm_pos
DB_USER=glm_pos

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root: sudo bash $0"

say "Checking what is already on this server (nothing is changed yet)"
if ss -tln | awk '{print $4}' | grep -qE "[:.]${API_PORT}\$"; then
  if [ ! -f "$ENV_FILE" ]; then fail "Port $API_PORT is already in use by something else. Re-run with another port:  API_PORT=4200 sudo -E bash $0"; fi
fi
command -v node >/dev/null || fail "Node.js is not installed."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "Node.js 20 or newer is needed (found $(node --version))."
echo "Node $(node --version) at $(command -v node)"
sudo -u postgres psql -tAc 'SELECT version();' >/dev/null || fail "PostgreSQL does not answer for the postgres user."
echo "PostgreSQL: $(sudo -u postgres psql -tAc 'SHOW server_version;')"
command -v caddy >/dev/null && echo "Caddy: $(caddy version | head -1)" || echo "Caddy was not found — the web/HTTPS step (enable-site.sh) needs it; tell me before cutover."

say "Small tools (only if missing — no upgrades)"
export DEBIAN_FRONTEND=noninteractive
MISSING=""
for t in git rsync curl openssl; do command -v "$t" >/dev/null || MISSING="$MISSING $t"; done
if [ -n "$MISSING" ]; then apt-get update -y && apt-get install -y $MISSING; fi

say "Service user"
id glm >/dev/null 2>&1 || adduser --system --group --home "$APP_DIR" --shell /usr/sbin/nologin glm

say "The code"
if [ ! -d "$APP_DIR/.git" ]; then
  GIT_SSH_COMMAND="$GIT_SSH" git clone --branch main "$REPO_URL" "$APP_DIR"
fi
if [ -f "$DEPLOY_KEY" ]; then
  # the service user pulls updates with the same read-only key (ssh insists the key is private to whoever uses it)
  chown glm:glm "$DEPLOY_KEY"
  chmod 600 "$DEPLOY_KEY"
  git -C "$APP_DIR" config core.sshCommand "$GIT_SSH"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
fi
chown -R glm:glm "$APP_DIR"
chmod +x "$APP_DIR"/deploy-vps/*.sh
# git refuses to work in a folder owned by another user unless told it is fine
git config --system --get-all safe.directory | grep -qxF "$APP_DIR" || git config --system --add safe.directory "$APP_DIR"

say "Database and settings (new secrets are made only the first time)"
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  DB_PASS="$(openssl rand -hex 24)"      # hex only, so it needs no escaping inside the connection URL
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE $DB_USER PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  ( umask 077
    cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$API_PORT
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
JWT_SECRET=$(openssl rand -hex 32)
DATA_KEY=$(openssl rand -hex 32)
CORS_ORIGINS=https://$WEB_HOST
TRUST_PROXY=1
ENV
  )
  chown root:glm "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "Wrote $ENV_FILE (new database password, JWT_SECRET and DATA_KEY; nobody else has seen them). Copy DATA_KEY into a password manager: sudo grep ^DATA_KEY= $ENV_FILE"
else
  echo "$ENV_FILE already exists — left as it is."
fi

say "Installing the app's runtime packages (Prisma)"
sudo -u glm bash -c "cd '$APP_DIR/deploy/api' && npm install --omit=dev"

say "Web files"
mkdir -p /var/www/pos
rsync -a --delete "$APP_DIR/deploy/web/" /var/www/pos/
chmod -R a+rX /var/www/pos

say "Caddy snippet (installed but NOT switched on — that happens at cutover with enable-site.sh)"
sed -e "s/__WEB_HOST__/$WEB_HOST/g" -e "s/__API_HOST__/$API_HOST/g" -e "s/__API_PORT__/$API_PORT/g" "$APP_DIR/deploy-vps/caddy-glm-pos.caddy" > /etc/caddy/glm-pos.caddy 2>/dev/null \
  || echo "(could not write /etc/caddy/glm-pos.caddy — is Caddy installed? enable-site.sh will tell you)"

say "systemd service (enabled, not started yet)"
cp "$APP_DIR/deploy-vps/glm-pos-api.service" /etc/systemd/system/glm-pos-api.service
systemctl daemon-reload
systemctl enable glm-pos-api

say "Nightly backup"
mkdir -p /var/backups/glm-pos
chmod 700 /var/backups/glm-pos
cat > /etc/cron.d/glm-pos-backup <<CRON
# Every night at 02:15 (server time): dump the GLM POS database, keep 30 days
15 2 * * * root $APP_DIR/deploy-vps/backup.sh >> /var/log/glm-pos-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/glm-pos-backup

say "Done"
cat <<NEXT

Ready, and nothing belonging to the other applications was touched. The app is not started yet. Next:
  1. Fill the database:  restore a backup   (sudo $APP_DIR/deploy-vps/restore.sh /path/to/glm_pos.dump)
  2. Start the app:      sudo $APP_DIR/deploy-vps/update.sh
  3. Check it:           curl http://127.0.0.1:$API_PORT/api/health
  4. On cutover day, after DNS points here:   sudo $APP_DIR/deploy-vps/enable-site.sh
NEXT
