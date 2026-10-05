# Moving to a VPS (Contabo) — pos.glmgroup.co.ke + api.glmgroup.co.ke

The cPanel setup is described in `DEPLOYMENT.md`. This is the same system on your own server: **Nginx** serves the web app and forwards the API to **Node** (run by `systemd`), with **PostgreSQL** on the same machine and free **Let's Encrypt** HTTPS. Everything is in the `deploy-vps/` folder:

| File | What it does |
|---|---|
| `setup-server.sh` | One-time setup of a fresh Ubuntu server (packages, database, firewall, Nginx, service, nightly backup) |
| `update.sh` | **Every later deploy**: backup → pull latest → update tables → copy web files → restart → health check |
| `backup.sh` / `restore.sh` | Database dump (nightly + before every update) and restore |
| `nginx-glm-pos.conf`, `glm-pos-api.service` | The Nginx site and the systemd service (setup installs them) |

Nothing here needs your passwords in chat. You run the commands; paste the **output** back if something looks wrong (never a password, key or `DATABASE_URL`).

Plan: **A** build the server and test it (no effect on the live site) → **B** rehearse with a copy of the data → **C** cutover day (~15 minutes of downtime) → **D** afterwards.

---

## A. Build the server (no downtime)

### A1. In the Contabo panel
1. Create/reinstall the VPS with **Ubuntu 24.04** and add your **SSH key** (made in A2). Note the server's **IP address**.
2. Turn on two-factor authentication for your Contabo account.

### A2. Make an SSH key on your computer (Windows PowerShell)
```powershell
ssh-keygen -t ed25519 -C "glm-vps"
```
Press Enter for the default location. Show the **public** key (this is the one you paste into Contabo — never the file without `.pub`):
```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

### A3. Log in and install
Replace `VPS_IP` with the server's IP:
```powershell
ssh root@VPS_IP
```
The repository is **private**, so the server gets a **read-only deploy key** (it can read the code and nothing else — no passwords or tokens to type, and it can't change anything on GitHub).

On the server, install git and make the key:
```bash
apt-get update && apt-get install -y git
```
```bash
mkdir -p /etc/glm-pos && ssh-keygen -t ed25519 -N "" -C "glm-vps-deploy" -f /etc/glm-pos/deploy_key
```
Show the **public** half (this one is safe to copy and paste anywhere):
```bash
cat /etc/glm-pos/deploy_key.pub
```
On GitHub: the repository → **Settings → Deploy keys → Add deploy key**. Title `glm-vps`, paste the line above, leave **"Allow write access" unticked**, then **Add key**.

Back on the server, get the code with that key, then run the setup (takes a few minutes; it prints each step):
```bash
GIT_SSH_COMMAND="ssh -i /etc/glm-pos/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git clone git@github.com:benaokoth-lgtm/GLM-BRANDING-SYSTEM.git /opt/glm-pos
```
```bash
bash /opt/glm-pos/deploy-vps/setup-server.sh
```
The setup hands the key to the service user, so `update.sh` can pull later with no further steps.

### A4. Make a normal admin login and lock the door
Still as `root`. This creates the user `glmadmin` (key login only):
```bash
adduser --disabled-password --gecos "" glmadmin && usermod -aG sudo glmadmin
```
```bash
mkdir -p /home/glmadmin/.ssh && cp /root/.ssh/authorized_keys /home/glmadmin/.ssh/ && chown -R glmadmin:glmadmin /home/glmadmin/.ssh && chmod 700 /home/glmadmin/.ssh && chmod 600 /home/glmadmin/.ssh/authorized_keys
```
```bash
echo "glmadmin ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/glmadmin && chmod 440 /etc/sudoers.d/glmadmin
```
**Test it in a second PowerShell window before going on** (if this fails, do not continue):
```powershell
ssh glmadmin@VPS_IP
```
Only when that works, back in the root window, turn off root and password logins:
```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/99-hardening.conf && systemctl reload ssh
```
From now on use `glmadmin` and put `sudo` in front of the deploy commands.

### A5. Quick check that the pieces are in place
```bash
systemctl is-active nginx postgresql fail2ban
```
Each line should say `active`. (The API is not started yet — that happens in B.)

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
scp "$env:USERPROFILE\Downloads\glm_pos.dump" glmadmin@VPS_IP:/home/glmadmin/
```

### B3. Restore it and start the API (on the VPS)
```bash
sudo /opt/glm-pos/deploy-vps/restore.sh /home/glmadmin/glm_pos.dump
```
Type `YES` when asked. Then bring the tables up to date with the latest code and start the API:
```bash
sudo /opt/glm-pos/deploy-vps/update.sh
```
It ends with `API is up.` and the commit it is running.

### B4. Test it without touching DNS
```bash
curl -H "Host: api.glmgroup.co.ke" http://127.0.0.1/api/health
```
```bash
curl -s -H "Host: api.glmgroup.co.ke" http://127.0.0.1/api/auth/users | head -c 300
```
```bash
curl -sI -H "Host: pos.glmgroup.co.ke" http://127.0.0.1/ | head -3
```
You should see `{"ok":true}`, the list of staff names from your real data, and `200 OK` for the web page.

---

## C. Cutover day (about 15 minutes of downtime)

**The day before:** at your registrar, lower the TTL of the DNS records for `pos` and `api` to **300 seconds** (5 minutes), so the switch is quick.

1. **Tell staff** the system will be down for ~15 minutes.
2. **Freeze the old system:** cPanel → Setup Node.js App → **Stop App**. Nothing can be entered from now on.
3. **Fresh dump** (B1), **download and upload** (B2), then **restore and update** (B3). This replaces the rehearsal copy with the final data.
4. **Switch DNS** at the registrar — **only these two names**; leave the main domain, `www`, `mail`, `webmail`, `cpanel` and all **MX** (email) records pointing at cPanel, or your company email stops. Change the **A** record of `pos.glmgroup.co.ke` and of `api.glmgroup.co.ke` to the VPS IP (delete any old **AAAA** record for them unless you add the VPS's IPv6 address). Check from your computer until both show the new IP:
   ```powershell
   nslookup api.glmgroup.co.ke
   ```
   ```powershell
   nslookup pos.glmgroup.co.ke
   ```
5. **HTTPS** (on the VPS, once step 4 shows the new IP; replace the email — it is only for certificate expiry warnings):
   ```bash
   sudo certbot --nginx -d pos.glmgroup.co.ke -d api.glmgroup.co.ke --redirect -m YOUR_EMAIL --agree-tos --no-eff-email
   ```
   ```bash
   sudo certbot renew --dry-run
   ```
6. **Check in the browser** (hard-refresh with Ctrl+F5): sign in; capture an order; open and print an invoice; take a payment; Master Data → Email → send a test; Master Data → M-Pesa → check the settings and make one test payment/match; open Production and Compliance.
7. **Everyone signs in again once** — the new server has a new `JWT_SECRET`. That is expected and is the secret rotation we wanted.

**Rollback** if something is badly wrong in the first hours: at the registrar point both records back at the old cPanel IP and start the app again in Setup Node.js App. (Anything entered on the VPS after the cutover would be missing there — so decide early rather than late.)

---

## D. Afterwards

- **Backups**: they run every night at 02:15. Make one now and look at it:
  ```bash
  sudo /opt/glm-pos/deploy-vps/backup.sh && ls -lh /var/backups/glm-pos/
  ```
  A backup on the same server is lost with the server. Set up an **off-server copy** (rclone to Contabo Object Storage or another place — the instructions are at the top of `backup.sh`); ask me and I will walk you through it.
- **Prove the restore works** once, on a spare database or the rehearsal copy, before you rely on it.
- **Deploy a new version** (replaces "Update from Remote → Deploy HEAD Commit" + `db:push` + restart):
  ```bash
  sudo /opt/glm-pos/deploy-vps/update.sh
  ```
  If it stops at the table update with a warning about deleting data, **don't force it** — paste what it printed.
- **Logs**: `journalctl -u glm-pos-api -n 100 --no-pager` (API) and `/var/log/nginx/error.log` (web).
- **Monitoring**: add a free uptime check (for example UptimeRobot) on `https://api.glmgroup.co.ke/api/health`.
- **Updates**: security updates install by themselves; reboot occasionally (`sudo reboot`) when Ubuntu asks.
- **Keep the cPanel account for about a week** as a safety net, then cancel it. Keep the final dump file somewhere safe.

## If something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| Browser says 502 Bad Gateway | The API is not running: `sudo systemctl status glm-pos-api`, then `journalctl -u glm-pos-api -n 60 --no-pager` |
| Site loads but login says "Failed to fetch" / CORS error | `CORS_ORIGINS` in `/etc/glm-pos/api.env` must be exactly `https://pos.glmgroup.co.ke`; after editing run `sudo systemctl restart glm-pos-api` |
| `certbot` fails | DNS has not reached the VPS yet (check `nslookup`), or port 80 is blocked — `sudo ufw status` should list 80 and 443 |
| "Too many login attempts" for everyone | `TRUST_PROXY=1` missing from `/etc/glm-pos/api.env` (setup writes it) |
| `update.sh` fails at the tables step | Paste the message here; it refuses on purpose rather than delete data |
| Dates show a day off | Time zone: `timedatectl` should say Africa/Nairobi |
