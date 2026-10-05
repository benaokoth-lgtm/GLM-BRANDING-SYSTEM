# Moving to the Contabo VPS — pos.glmgroup.co.ke + api.glmgroup.co.ke

The cPanel setup is described in `DEPLOYMENT.md`. This is the same system on your Contabo server, **which already runs other applications** (Olerai Hotel, Word Power Church …). The kit in `deploy-vps/` therefore adds GLM **next to** them and touches nothing of theirs:

- It uses the server's existing **Caddy** (ports 80/443, automatic HTTPS), **PostgreSQL 16** and **Node 20**. It installs **no** web server, firewall rules, package upgrades or time-zone change.
- GLM gets its own **database and user** (`glm_pos`), its own **service user** (`glm`), its own folder `/opt/glm-pos`, its own **systemd service** `glm-pos-api` on **port 4100**, and its own settings file `/etc/glm-pos/api.env` with newly generated secrets.
- The service runs with the Kenyan time zone (`TZ=Africa/Nairobi`) so "today" in the books is the Kenyan day, whatever the server uses.

| File | What it does |
|---|---|
| `setup-server.sh` | One-time setup on the shared server (checks first, then adds GLM; nothing started yet) |
| `enable-site.sh` | **Cutover day:** adds pos/api to Caddy once DNS points here (backs up and validates the Caddyfile) |
| `update.sh` | **Every later deploy:** backup → pull latest → update tables → copy web files → restart → health check |
| `backup.sh` / `restore.sh` | Database dump (nightly + before every update) and restore |
| `caddy-glm-pos.caddy`, `glm-pos-api.service` | The Caddy sites and the systemd service |

Nothing here needs your passwords in chat. You run the commands; paste the **output** back if something looks wrong (never a password, key or `DATABASE_URL`).

Plan: **A** put GLM on the server (invisible to users, other apps unaffected) → **B** rehearse with a copy of the data → **C** cutover day (~15 minutes of downtime) → **D** afterwards.

---

## A. Put GLM on the server

You log in as `root` from PowerShell: `ssh root@169.58.235.15`. (Your own key was added to the server in an earlier step, so a key login also works.)

### A1. Give the server a read-only key for the private repository
The repository is **private**, so the server gets a **deploy key** (it can read the code and nothing else, and it can't change anything on GitHub). On the server as `root`:
```bash
mkdir -p /etc/glm-pos && ssh-keygen -t ed25519 -N "" -C "glm-vps-deploy" -f /etc/glm-pos/deploy_key
```
Show the **public** half (safe to copy and paste anywhere):
```bash
cat /etc/glm-pos/deploy_key.pub
```
On GitHub: the repository → **Settings → Deploy keys → Add deploy key**. Title `glm-vps`, paste that line, leave **"Allow write access" unticked**, then **Add key**.

### A2. Get the code with that key
```bash
GIT_SSH_COMMAND="ssh -i /etc/glm-pos/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git clone git@github.com:benaokoth-lgtm/GLM-BRANDING-SYSTEM.git /opt/glm-pos
```
(If it says the repository is not found, copy the exact name from GitHub and tell me.)

### A3. Run the setup
```bash
bash /opt/glm-pos/deploy-vps/setup-server.sh
```
It first prints what it finds (Node version, PostgreSQL, Caddy, whether port 4100 is free) and stops with a clear message if something is not as expected. Then it creates the database and settings, installs the service and the nightly backup, and prints the next steps. It does **not** start the app and does **not** touch Caddy yet.

---

## B. Rehearsal with a copy of the data

### B1. Dump the database on the old cPanel host
First free the account's processes (see the resource-limit steps we used earlier), then in cPanel **Terminal** (use the DB user from cPanel → PostgreSQL Databases; it asks for the password **there** — type it in that terminal only):
```bash
pg_dump -Fc --no-owner -h 127.0.0.1 -U DBUSER DBNAME -f ~/glm_pos.dump
```
```bash
ls -lh ~/glm_pos.dump
```
A real file (not 0 bytes) should be listed. Download it with cPanel **File Manager** (Home → `glm_pos.dump` → Download).

### B2. Send it to the VPS (PowerShell on your computer)
```powershell
scp "$env:USERPROFILE\Downloads\glm_pos.dump" root@169.58.235.15:/root/
```

### B3. Restore it and start the API (on the VPS)
```bash
/opt/glm-pos/deploy-vps/restore.sh /root/glm_pos.dump
```
Type `YES` when asked. Then bring the tables up to date with the latest code and start the API:
```bash
/opt/glm-pos/deploy-vps/update.sh
```
It ends with `API is up.` and the commit it is running.

### B4. Test it (the web address is not live yet, so test the API directly)
```bash
curl http://127.0.0.1:4100/api/health
```
```bash
curl -s http://127.0.0.1:4100/api/auth/users | head -c 300
```
You should see `{"ok":true}` and the list of staff names from your real data. Also confirm the other applications are unaffected:
```bash
systemctl is-active caddy postgresql@16-main pm2-oleraihotel glm-pos-api
```
All four should say `active`.

---

## C. Cutover day (about 15 minutes of downtime)

**The day before:** at your registrar, lower the TTL of the DNS records for `pos` and `api` to **300 seconds** (5 minutes), so the switch is quick.

1. **Tell staff** the system will be down for ~15 minutes.
2. **Freeze the old system:** cPanel → Setup Node.js App → **Stop App**. Nothing can be entered from now on.
3. **Fresh dump** (B1), **download and upload** (B2), then **restore and update** (B3). This replaces the rehearsal copy with the final data.
4. **Switch DNS** at the registrar — **only these two names**; leave the main domain, `www`, `mail`, `webmail`, `cpanel` and all **MX** (email) records pointing at cPanel, or your company email stops. Change the **A** record of `pos.glmgroup.co.ke` and of `api.glmgroup.co.ke` to **169.58.235.15** (delete any old **AAAA** record for them). Check from your computer until both show the new IP:
   ```powershell
   nslookup api.glmgroup.co.ke
   ```
   ```powershell
   nslookup pos.glmgroup.co.ke
   ```
5. **Switch the sites on** (on the VPS, once step 4 shows the new IP). This checks DNS, backs up Caddy's file, adds the two sites, validates and reloads Caddy; Caddy then gets the HTTPS certificates by itself:
   ```bash
   /opt/glm-pos/deploy-vps/enable-site.sh
   ```
   Wait a minute, then:
   ```bash
   curl -I https://pos.glmgroup.co.ke
   ```
   ```bash
   curl https://api.glmgroup.co.ke/api/health
   ```
6. **Check in the browser** (hard-refresh with Ctrl+F5): sign in; capture an order; open and print an invoice; take a payment; Master Data → Email → send a test; Master Data → M-Pesa → check the settings and make one test payment/match; open Production and Compliance.
7. **Everyone signs in again once** — the new server has a new `JWT_SECRET`. That is expected and is the secret rotation we wanted.

**Rollback** if something is badly wrong in the first hours: at the registrar point both records back at the old cPanel IP and start the app again in Setup Node.js App. (Anything entered on the VPS after the cutover would be missing there — so decide early rather than late.) To take GLM out of Caddy again, remove the two lines `# GLM Branding POS …` and `import /etc/caddy/glm-pos.caddy` from the end of the Caddyfile (a backup `Caddyfile.bak-glm-…` sits next to it) and run `systemctl reload caddy`.

---

## D. Afterwards

- **Backups** run every night at 02:15 (server time) and before every update. Make one now and look at it:
  ```bash
  /opt/glm-pos/deploy-vps/backup.sh && ls -lh /var/backups/glm-pos/
  ```
  A backup on the same server is lost with the server. Set up an **off-server copy** (rclone to Contabo Object Storage or another place — instructions are at the top of `backup.sh`); ask me and I will walk you through it. This server already has an `/opt/backups` folder for the other apps — GLM keeps its own in `/var/backups/glm-pos` so nothing gets mixed up.
- **Prove the restore works** once, on a spare database, before you rely on it.
- **Deploy a new version** (replaces "Update from Remote → Deploy HEAD Commit" + `db:push` + restart):
  ```bash
  /opt/glm-pos/deploy-vps/update.sh
  ```
  If it stops at the table update with a warning about deleting data, **don't force it** — paste what it printed.
- **Logs**: `journalctl -u glm-pos-api -n 100 --no-pager` (API) and `journalctl -u caddy -n 100 --no-pager` (web/HTTPS).
- **Monitoring**: add a free uptime check (for example UptimeRobot) on `https://api.glmgroup.co.ke/api/health`.
- **Keep the cPanel account for about a week** as a safety net, then cancel it. Keep the final dump file somewhere safe.
- **Looking after the shared server**: it holds several businesses now, so keep Contabo two-factor authentication on, and consider (separately) turning off root password login once you only use keys.

## If something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| `setup-server.sh` stops with "Port 4100 is already in use" | Another app uses it: run `API_PORT=4200 bash /opt/glm-pos/deploy-vps/setup-server.sh` (and tell me — the Caddy snippet follows the port) |
| `enable-site.sh` says a name does not point at this server | DNS has not reached the VPS yet: check `nslookup`, wait, run it again |
| Browser says "502 Bad Gateway" | The API is not running: `systemctl status glm-pos-api`, then `journalctl -u glm-pos-api -n 60 --no-pager` |
| Site loads but login says "Failed to fetch" / CORS error | `CORS_ORIGINS` in `/etc/glm-pos/api.env` must be exactly `https://pos.glmgroup.co.ke`; after editing run `systemctl restart glm-pos-api` |
| No HTTPS certificate yet | `journalctl -u caddy -n 60 --no-pager` — usually DNS not final or port 80 blocked |
| "Too many login attempts" for everyone | `TRUST_PROXY=1` missing from `/etc/glm-pos/api.env` (setup writes it) |
| `update.sh` fails at the tables step | Paste the message here; it refuses on purpose rather than delete data |
