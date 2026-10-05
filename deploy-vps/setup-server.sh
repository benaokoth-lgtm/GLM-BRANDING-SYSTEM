#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04 / 24.04 VPS for the GLM Branding POS (API + web).
#
#   sudo bash /opt/glm-pos/deploy-vps/setup-server.sh
#
# What it does: installs Nginx, PostgreSQL, Node 20, Certbot, a firewall (only SSH, HTTP, HTTPS are open), fail2ban and automatic security
# updates; creates the database and a locked-down service user; writes the settings file (with freshly generated secrets); installs the
# Nginx site, the systemd service and the nightly backup. It does NOT start the app — the database is filled first (restore a backup, or
# `update.sh` creates the empty tables), and then update.sh starts it. Safe to run again: it never overwrites existing secrets.
set -euo pipefail

WEB_HOST="${WEB_HOST:-pos.glmgroup.co.ke}"
API_HOST="${API_HOST:-api.glmgroup.co.ke}"
REPO_URL="${REPO_URL:-https://github.com/benaokoth-lgtm/GLM-BRANDING-SYSTEM.git}"
APP_DIR=/opt/glm-pos
ENV_DIR=/etc/glm-pos
ENV_FILE="$ENV_DIR/api.env"
DB_NAME=glm_pos
DB_USER=glm_pos

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run this as root: sudo bash $0"; exit 1; }
. /etc/os-release
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) echo "This kit is written for Ubuntu 22.04 or 24.04 (found ${PRETTY_NAME:-unknown}). Stop here and tell me." ; exit 1 ;; esac

say "Time zone: Africa/Nairobi (so \"today\" in the books is the Kenyan day)"
timedatectl set-timezone Africa/Nairobi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y nginx postgresql postgresql-contrib certbot python3-certbot-nginx ufw fail2ban unattended-upgrades git curl rsync ca-certificates openssl

say "Node.js 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

say "Service user"
id glm >/dev/null 2>&1 || adduser --system --group --home "$APP_DIR" --shell /usr/sbin/nologin glm

say "The code"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch main "$REPO_URL" "$APP_DIR"
fi
chown -R glm:glm "$APP_DIR"
chmod +x "$APP_DIR"/deploy-vps/*.sh
# git refuses to work in a folder owned by another user unless told it is fine
git config --system --add safe.directory "$APP_DIR" || true

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
PORT=4100
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
JWT_SECRET=$(openssl rand -hex 32)
CORS_ORIGINS=https://$WEB_HOST
TRUST_PROXY=1
ENV
  )
  chown root:glm "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "Wrote $ENV_FILE (new database password and JWT_SECRET; nobody else has seen them)."
else
  echo "$ENV_FILE already exists — left as it is."
fi

say "Installing the app's runtime packages (Prisma)"
sudo -u glm bash -c "cd '$APP_DIR/deploy/api' && npm install --omit=dev"

say "Nginx"
sed -e "s/__WEB_HOST__/$WEB_HOST/g" -e "s/__API_HOST__/$API_HOST/g" "$APP_DIR/deploy-vps/nginx-glm-pos.conf" > /etc/nginx/sites-available/glm-pos
ln -sf /etc/nginx/sites-available/glm-pos /etc/nginx/sites-enabled/glm-pos
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/pos
rsync -a --delete "$APP_DIR/deploy/web/" /var/www/pos/
nginx -t
systemctl reload nginx

say "systemd service (enabled, not started yet)"
cp "$APP_DIR/deploy-vps/glm-pos-api.service" /etc/systemd/system/glm-pos-api.service
systemctl daemon-reload
systemctl enable glm-pos-api

say "Nightly backup"
mkdir -p /var/backups/glm-pos
chmod 700 /var/backups/glm-pos
cat > /etc/cron.d/glm-pos-backup <<CRON
# Every night at 02:15 (Nairobi time): dump the database, keep 30 days
15 2 * * * root $APP_DIR/deploy-vps/backup.sh >> /var/log/glm-pos-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/glm-pos-backup

say "Firewall, brute-force protection, automatic security updates"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
cat > /etc/apt/apt.conf.d/20auto-upgrades <<APT
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

say "Done"
cat <<NEXT

The server is ready but the app is not started yet. Next:
  1. Fill the database:  restore a backup   (sudo $APP_DIR/deploy-vps/restore.sh /root/glm_pos.dump)
                         or start empty and create the first Admin (see DEPLOYMENT-VPS.md).
  2. Start the app:      sudo $APP_DIR/deploy-vps/update.sh
  3. Check it:           curl -H 'Host: $API_HOST' http://127.0.0.1/api/health
NEXT
