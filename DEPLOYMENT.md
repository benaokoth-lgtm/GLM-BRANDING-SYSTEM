# Deploying to cPanel — api.glmgroup.co.ke + pos.glmgroup.co.ke

This monorepo has two pieces to host on the web: `apps/api` (an Express + Postgres server, via
cPanel's **Setup Node.js App**) and `apps/web` (a static React build, served as plain files).
The root domain `glmgroup.co.ke` itself is left untouched by this deploy — the app lives on its
own `pos.glmgroup.co.ke` subdomain instead, so the root domain stays free for GLM's main site.

One Git Version Control clone drives both, via the root `.cpanel.yml`.

## 1. Create the production database

cPanel → **PostgreSQL Databases**:

- Create a database (cPanel will prefix it with your username, e.g. `youruser_glmpos`)
- Create a database user + password, add it to the database with **all privileges**
- Note the connection details — cPanel-hosted Postgres is normally reachable at
  `localhost:5432` from the same account's Node apps. Your `DATABASE_URL` will look like:
  ```
  postgresql://youruser_dbuser:yourpassword@localhost:5432/youruser_glmpos
  ```

If your hosting plan doesn't offer PostgreSQL (some budget shared-hosting plans only have
MySQL/MariaDB), see "Using MySQL instead" at the bottom before continuing.

## 2. Create the API's Node.js App

cPanel → **Setup Node.js App** → Create Application:

- **Node.js version**: 18 or newer
- **Application mode**: Production
- **Application root**: `repositories/glm-branding-pos-system` (this becomes
  `/home/<username>/repositories/glm-branding-pos-system` — the git clone lives here, shared
  with apps/web's build step)
- **Application URL**: `api.glmgroup.co.ke`
- **Application startup file**: `apps/api/dist/server.js`

Copy the `source /home/<username>/nodevenv/.../bin/activate` command cPanel shows you — needed
for `.cpanel.yml` in step 5.

### Environment variables (on this Node.js App)

Required:

| Variable | Value |
|---|---|
| `DATABASE_URL` | From step 1 |
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CORS_ORIGINS` | `https://pos.glmgroup.co.ke` |
| `NODE_ENV` | `production` |

You do **not** need to set `PORT` — Passenger assigns its own and the app already reads
`process.env.PORT`.

Optional, only if/when you turn these on (leave unset otherwise — each feature disables itself
cleanly, e.g. "Send email" returns a clear error instead of crashing):

| Variable | Value |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Your outgoing mail provider's SMTP credentials, for the "Send email" action on invoices/quotations |
| `SMTP_FROM` | Optional — defaults to `SMTP_USER` |
| `MPESA_ENV` | `production` (or leave as `sandbox` while testing) |
| `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` | From your Safaricom Daraja app |
| `MPESA_CALLBACK_URL` | `https://api.glmgroup.co.ke/api/mpesa/callback` — must be publicly reachable, so this only works once the API is actually live at that URL |

See `apps/api/.env.example` for the full list with inline notes.

## 3. Create the pos.glmgroup.co.ke subdomain

cPanel → **Domains** (or **Subdomains**) → create `pos.glmgroup.co.ke`. Note its **document
root** path — you'll need it for `.cpanel.yml` in step 5.

## 4. Set up Git Version Control

cPanel → **Git™ Version Control** → Create:

- **Clone URL**: `https://github.com/benaokoth-lgtm/GLM-BRANDING-SYSTEM.git`
- **Repository Path**: `/home/<username>/repositories/glm-branding-pos-system` — same path as
  the Application Root in step 2
- **Branch**: `main`

## 5. Fix `.cpanel.yml`'s placeholders

Edit the repo's `.cpanel.yml` (via cPanel File Manager, or locally and push) and replace:

- `REPLACE_WITH_CPANEL_USERNAME` → your cPanel username
- `REPLACE_WITH_NODE_VERSION` → the Node version from step 2 (e.g. `20`)
- `REPLACE_WITH_POS_DOCROOT` → the subdomain's document root path from step 3, **relative to
  your home directory** (e.g. if the full path is `/home/youruser/pos.glmgroup.co.ke`, use
  `pos.glmgroup.co.ke`)

## 6. First deploy

**Pull or Deploy** tab → **Update from Remote** → **Deploy HEAD Commit**. This runs
`.cpanel.yml`: flips the Prisma schema to postgresql, installs dependencies, syncs the database
schema, builds `packages/shared` → `apps/api` → `apps/web`, copies the web build to the pos
subdomain, and restarts the API.

If `.cpanel.yml` isn't fixed up yet, run the equivalent commands manually via cPanel's
**Terminal** first (activate the nodevenv shown in step 2, then run each line from
`.cpanel.yml` by hand), then use **Setup Node.js App**'s **Restart** button.

This is a fresh production database with no login at all yet — do **not** run the dev seed
script (`npm run db:seed`, i.e. `prisma/seed.ts`): it wipes every table and recreates a full
demo dataset with hardcoded, hand-typed PINs, meant for local development, not a real business.
Instead, via cPanel Terminal (with the nodevenv activated, from `apps/api`):

```
npx tsx prisma/seed-admin.ts "Your Name"
```

This creates exactly one Admin user with a freshly random PIN, printed once — capture it, log
in, then set up Company Info, Staff, Services, and Materials for real under Master Data. There's
no PIN-reset or staff-removal feature yet, so keep that PIN somewhere safe.

## 7. Ongoing schema changes

This app has no Prisma Migrate history — schema changes have always gone through `prisma db
push` in dev (see `package.json`'s `db:push` script), and `.cpanel.yml` uses the exact same
tool against the production database on every deploy. That's fine for a straightforward column
add or a new table; for anything that could lose data on a table that already has real rows
(dropping a column, narrowing a type), `db push` **refuses to apply it** rather than doing it
silently — the deploy step fails, and you resolve it deliberately via cPanel Terminal (either
accept the loss explicitly with `npx prisma db push --accept-data-loss` after confirming that's
actually fine, or write a manual `ALTER TABLE` migrating the data first). If schema changes
become frequent enough that this manual-intervention model gets tedious, that's the point to
adopt proper Prisma Migrate (`prisma migrate dev` locally, `prisma migrate deploy` in
`.cpanel.yml`) instead — not needed to go live.

## SSL

Once `pos.glmgroup.co.ke` and `api.glmgroup.co.ke`'s DNS resolves to this hosting account,
cPanel's AutoSSL (Let's Encrypt) issues certificates for both automatically.

## Using MySQL instead

If your hosting plan doesn't offer PostgreSQL, swap `postgresql` for `mysql` everywhere in this
document and in `.cpanel.yml`'s `set-db-provider.mjs` call — `apps/api/scripts/set-db-provider.mjs`
only special-cases `sqlite`/`postgresql` right now, so its regex would need a small edit to also
accept `mysql` (or just add a third branch), and `DATABASE_URL` becomes a
`mysql://user:pass@localhost:3306/dbname` connection string from cPanel's **MySQL Databases**
tool instead of PostgreSQL Databases. Everything else in this document is unchanged.
