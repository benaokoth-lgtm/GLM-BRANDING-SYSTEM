#!/usr/bin/env bash
# Switch on pos.glmgroup.co.ke and api.glmgroup.co.ke in the server's Caddy — run this on cutover day, AFTER the DNS records point here.
#
#   sudo /opt/glm-pos/deploy-vps/enable-site.sh
#
# It checks that both names already resolve to this server (Caddy cannot get a certificate otherwise), backs up the Caddyfile, adds one
# `import` line, validates the result (restoring the backup if Caddy rejects it) and reloads Caddy. The other sites in the Caddyfile are
# not touched. Caddy then gets the HTTPS certificates by itself within a minute.
set -euo pipefail

WEB_HOST="${WEB_HOST:-pos.glmgroup.co.ke}"
API_HOST="${API_HOST:-api.glmgroup.co.ke}"
SNIPPET=/etc/caddy/glm-pos.caddy

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root: sudo $0"
command -v caddy >/dev/null || fail "Caddy is not installed."
[ -f "$SNIPPET" ] || fail "$SNIPPET is missing — run setup-server.sh first."

CADDYFILE="$(systemctl cat caddy 2>/dev/null | grep -oE -- '--config[ =][^ ]+' | head -1 | sed -E 's/--config[ =]//' || true)"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
[ -f "$CADDYFILE" ] || fail "Could not find Caddy's configuration file (looked for $CADDYFILE). Tell me which file Caddy uses."
echo "Caddy configuration: $CADDYFILE"

say "Do both names point at this server?"
MYIP="$(curl -4 -fsS https://api.ipify.org || true)"
echo "This server's public address: ${MYIP:-unknown}"
BAD=0
for h in "$WEB_HOST" "$API_HOST"; do
  GOT="$(getent ahostsv4 "$h" | awk '{print $1; exit}' || true)"
  echo "$h -> ${GOT:-no answer}"
  [ -n "$MYIP" ] && [ "$GOT" = "$MYIP" ] || BAD=1
done
if [ "$BAD" = 1 ] && [ "${FORCE:-0}" != 1 ]; then
  fail "A name does not point at this server yet. Change the DNS records, wait a few minutes, and run this again (or FORCE=1 to go ahead anyway)."
fi

say "Adding the sites to Caddy"
BACKUP=""
if ! grep -qF "import $SNIPPET" "$CADDYFILE"; then
  BACKUP="$CADDYFILE.bak-glm-$(date +%Y%m%d-%H%M%S)"
  cp "$CADDYFILE" "$BACKUP"
  printf '\n# GLM Branding POS (added by deploy-vps/enable-site.sh)\nimport %s\n' "$SNIPPET" >> "$CADDYFILE"
else
  echo "Already imported — just validating and reloading."
fi

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>/tmp/glm-caddy-validate.log; then
  cat /tmp/glm-caddy-validate.log
  [ -n "$BACKUP" ] && cp "$BACKUP" "$CADDYFILE" && echo "Caddy rejected the change; the original Caddyfile was put back."
  fail "Nothing was changed. Paste the message above to me."
fi

systemctl reload caddy
say "Done"
echo "Caddy reloaded. Certificates are requested automatically; give it up to a minute, then:"
echo "  curl -I https://$WEB_HOST"
echo "  curl https://$API_HOST/api/health"
[ -n "$BACKUP" ] && echo "(The previous Caddyfile is saved as $BACKUP.)"
exit 0
