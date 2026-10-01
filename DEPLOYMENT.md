# Deploying to cPanel — api.glmgroup.co.ke + app.glmgroup.co.ke

Two pieces are hosted, both **prebuilt and committed under `deploy/`** — nothing is built on the server:

| Folder | What it is | Where it runs |
|---|---|---|
| `deploy/api/` | One bundled `server.js` (shared code inlined), a tiny `package.json` (only `@prisma/client` + `prisma`), and the Prisma schema pre-set to PostgreSQL | cPanel **Setup Node.js App** → this folder is the *Application root* |
| `deploy/web/` | The static React build (API URL baked in) + `.htaccess` for client-side routes | Copied to the `app.glmgroup.co.ke` document root |

**Why not build on the server?** cPanel's Node.js Selector replaces the app root's `node_modules` with a symlink into its own virtual env, which doesn't cooperate with this repo's npm-workspaces monorepo (npm sees one package and installs nothing). A slim, prebuilt app root is the layout the Selector is designed for. The monorepo itself is unchanged for local development.

## One-time setup

### 1. Database
cPanel → **PostgreSQL Databases**: create a database (no spaces in the name!), a user, and add the user to the database with all privileges. The connection string is:

```
postgresql://DBUSER:PASSWORD@127.0.0.1:5432/DBNAME
```

Use `127.0.0.1`, not `localhost` (this host rejects IPv6 `::1`). If the password contains `@ : / ? # %`, percent-encode those characters.

### 2. Git
cPanel → **Git™ Version Control** → Create: clone URL `https://github.com/benaokoth-lgtm/GLM-BRANDING-SYSTEM.git`, path `/home/glmgroup/repositories/glm-branding-pos-system`, branch `main`.

### 3. The API's Node.js App
cPanel → **Setup Node.js App** → Create (or edit) the application:

- **Node.js version**: 18 (or newer)
- **Application mode**: Production
- **Application root**: `repositories/glm-branding-pos-system/deploy/api`
- **Application URL**: `api.glmgroup.co.ke`
- **Application startup file**: `server.js`

**Environment variables — one row per variable, raw value only** (no `export`, no quotes, never several in one value):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the connection string from step 1 |
| `JWT_SECRET` | a long random string — generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it; changing it logs everyone out |
| `CORS_ORIGINS` | `https://app.glmgroup.co.ke` |

No `PORT` — Passenger assigns it. Optional (each feature disables itself cleanly if unset): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (invoice emails and the Admin's emailed PIN reset), and the `MPESA_*` set (see `apps/api/.env.example`; `MPESA_CALLBACK_URL` must be `https://api.glmgroup.co.ke/api/mpesa/callback`).

Save, then click **Run NPM Install** (this installs Prisma and generates its client), then **Restart**.

### 4. The web subdomain
cPanel → **Domains**: create `app.glmgroup.co.ke`; its document root should be `/home/glmgroup/app.glmgroup.co.ke` (what `.cpanel.yml` copies into). Do **not** use `pos.glmgroup.co.ke`: that hosts a separate PHP point-of-sale system, and `.cpanel.yml` refuses to deploy into any folder that has an `index.php`.

### 5. First deploy
**Git Version Control → Pull or Deploy → Update from Remote → Deploy HEAD Commit.** This copies `deploy/web` into the subdomain and restarts the API (`.cpanel.yml`).

### 6. Create the database tables and the first Admin
In cPanel **Terminal**, activate the app's environment (copy the exact `source …/activate` line shown at the top of the Setup Node.js App page), then:

```bash
cd /home/glmgroup/repositories/glm-branding-pos-system/deploy/api
export DATABASE_URL="postgresql://DBUSER:PASSWORD@127.0.0.1:5432/DBNAME"
npm run db:push
node seed-admin.js "Your Name"
```

`seed-admin.js` prints one random Admin PIN, once — keep it. Do **not** run the dev seed (`apps/api/prisma/seed.ts`) in production: it wipes every table and creates demo users with hard-coded PINs. Log in, then set up Company Info, Staff, Services and Materials under Master Data.

**Forgot a PIN, or a correct PIN "doesn't work"?** Five wrong attempts lock a user for 15 minutes. From the same folder and environment as above:

```bash
node reset-pin.js --list                 # who exists, and who is locked
node reset-pin.js "Your Name"            # new random 4-digit PIN (also clears any lockout)
node reset-pin.js "Your Name" 4821       # or choose the PIN yourself
```

**Emailed reset for the Admin ("Admin: forgot PIN?" on the login screen).** Give the Admin a recovery email once, from the same folder and environment:

```bash
node reset-pin.js "Your Name" --email you@example.com
```

Then on the login screen, *Admin: forgot PIN?* → enter that email → enter the 6-digit code it receives (valid 15 minutes, 5 tries, single use) and a new 4-digit PIN. This needs the `SMTP_*` environment variables (step 3) to be set — without them the screen says email isn't configured, and `reset-pin.js` above is the fallback. A cPanel mailbox (e.g. `pos@glmgroup.co.ke`, host `mail.glmgroup.co.ke`, port 465) is the simplest sender; Yahoo/Gmail need an *app password*, not the normal one. Only the Admin can use this, and the screen never reveals whether an email exists.

> Terminal tips for this host: paste one command at a time; if pasted text shows `^[[200~`, run `bind 'set enable-bracketed-paste off'` first; a new Terminal tab starts with no environment, so redo the `source …/activate` and `export` lines.

## Every later deploy

1. On your dev machine, after changing app code: `npm run build:cpanel` — regenerates `deploy/` (runs the web build with the production API URL and bundles the API).
2. Commit **including `deploy/`**, push to `main`.
3. cPanel → Git Version Control → **Update from Remote** → **Deploy HEAD Commit**.
4. Only if `deploy/api/package.json` changed (rare): Setup Node.js App → **Run NPM Install**, then **Restart**.
5. Only if `apps/api/prisma/schema.prisma` changed: in Terminal, `cd …/deploy/api`, export `DATABASE_URL`, `npm run db:push`. It refuses changes that would lose data; accept that deliberately with `npx prisma db push --accept-data-loss` after confirming it's fine, or migrate the data first. (This app has no Prisma Migrate history — `db push` is the tool in dev and production.)

If `git pull` complains about local changes on the server, the server's checkout has drifted — `git checkout -- .` on the tracked files, then pull again (never commit from the server).

## SSL
Once both subdomains' DNS points at this account, cPanel's AutoSSL (Let's Encrypt) issues certificates automatically.

## Using MySQL instead
Not wired up: the schema and `deploy/` are PostgreSQL-specific. It would need the provider swapped in `scripts/build-cpanel.mjs`, a `mysql://…` `DATABASE_URL`, and a check of the models for MySQL compatibility.
