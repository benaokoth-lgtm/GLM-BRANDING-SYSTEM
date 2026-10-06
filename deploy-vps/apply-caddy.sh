#!/usr/bin/env bash
# Apply the latest Caddy settings for the GLM POS sites (security headers, the larger limit for restoring a backup) to a server that is
# already running — without touching the other sites in the Caddyfile.
#
#   sudo /opt/glm-pos/deploy-vps/apply-caddy.sh
#
# It re-creates /etc/caddy/glm-pos.caddy from caddy-glm-pos.caddy using the same host names and port as the current file, keeps a copy
# of the old one, checks that Caddy accepts the WHOLE configuration, and only then reloads Caddy. If Caddy rejects it, the old file is
# put back and nothing changes.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/glm-pos}"
SNIPPET=/etc/caddy/glm-pos.caddy
TEMPLATE="$APP_DIR/deploy-vps/caddy-glm-pos.caddy"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root: sudo $0"
command -v caddy >/dev/null || fail "Caddy is not installed."
[ -f "$SNIPPET" ] || fail "$SNIPPET is missing — run setup-server.sh first."
[ -f "$TEMPLATE" ] || fail "$TEMPLATE is missing — has the code been updated (update.sh)?"

# The names and the port the running site already uses.
WEB_HOST="${WEB_HOST:-$(grep -E '^[A-Za-z0-9.-]+ \{' "$SNIPPET" | sed -n 1p | awk '{print $1}')}"
API_HOST="${API_HOST:-$(grep -E '^[A-Za-z0-9.-]+ \{' "$SNIPPET" | sed -n 2p | awk '{print $1}')}"
API_PORT="${API_PORT:-$(grep -oE 'reverse_proxy 127\.0\.0\.1:[0-9]+' "$SNIPPET" | head -1 | grep -oE '[0-9]+$')}"
[ -n "$WEB_HOST" ] && [ -n "$API_HOST" ] && [ -n "$API_PORT" ] || fail "Could not read the host names / port from $SNIPPET. Run with WEB_HOST=… API_HOST=… API_PORT=… $0"
echo "Web site: $WEB_HOST   API: $API_HOST   API port: $API_PORT"

CADDYFILE="$(systemctl cat caddy 2>/dev/null | grep -oE -- '--config[ =][^ ]+' | head -1 | sed -E 's/--config[ =]//' || true)"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
[ -f "$CADDYFILE" ] || fail "Could not find Caddy's configuration file ($CADDYFILE)."

say "Writing the new settings (the old file is kept)"
BACKUP="$SNIPPET.bak-$(date +%Y%m%d-%H%M%S)"
cp "$SNIPPET" "$BACKUP"
sed -e "s/__WEB_HOST__/$WEB_HOST/g" -e "s/__API_HOST__/$API_HOST/g" -e "s/__API_PORT__/$API_PORT/g" "$TEMPLATE" > "$SNIPPET"

say "Does Caddy accept the whole configuration?"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/glm-caddy-validate.log 2>&1; then
  cat /tmp/glm-caddy-validate.log
  cp "$BACKUP" "$SNIPPET"
  fail "Caddy rejected it, so the old settings were put back and nothing changed."
fi

systemctl reload caddy
say "Done — Caddy reloaded"
echo "Check the headers:  curl -sI https://$WEB_HOST | grep -iE 'strict-transport|x-frame|x-content-type|referrer|content-security'"
echo "The old settings are kept in $BACKUP"
