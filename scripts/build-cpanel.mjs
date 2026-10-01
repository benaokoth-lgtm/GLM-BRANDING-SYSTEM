// Builds the two self-contained pieces that get deployed to cPanel, into
// deploy/ (committed, so the server only has to pull — it never has to build):
//
//   deploy/api/  — one bundled server.js (+ seed-admin.js), a tiny
//                  package.json with only the real runtime packages, and the
//                  Prisma schema pre-flipped to PostgreSQL. This folder is the
//                  Node.js App's Application root.
//   deploy/web/  — the static React build for pos.glmgroup.co.ke, plus an
//                  .htaccess so client-side routes (/orders/mine etc.) load.
//
// Why: cPanel's Node.js Selector replaces the app root's node_modules with a
// symlink into its own virtual env, which doesn't cooperate with npm
// workspaces — so a monorepo install + build on the server never worked. A
// slim, prebuilt app root is the layout the Selector is designed for.
//
// Run from the repo root after changing app code:  npm run build:cpanel
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'deploy');
const apiOut = path.join(out, 'api');
const webOut = path.join(out, 'web');

const API_URL = process.env.VITE_API_URL || 'https://api.glmgroup.co.ke/api';
const PRISMA_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'apps/api/package.json'), 'utf8')).dependencies['@prisma/client'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(apiOut, 'prisma'), { recursive: true });
fs.mkdirSync(webOut, { recursive: true });

// ── API ───────────────────────────────────────────────────────────────────
// Everything is bundled (including @glm/shared, which is raw TypeScript and
// can't be required by plain node) except @prisma/client, which needs its
// generated client + native query engine from `prisma generate` on the server.
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['@prisma/client'],
  logLevel: 'warning',
  legalComments: 'none',
};
await build({ ...common, entryPoints: [path.join(root, 'apps/api/src/server.ts')], outfile: path.join(apiOut, 'server.js') });
await build({ ...common, entryPoints: [path.join(root, 'apps/api/prisma/seed-admin.ts')], outfile: path.join(apiOut, 'seed-admin.js') });
await build({ ...common, entryPoints: [path.join(root, 'apps/api/prisma/reset-pin.ts')], outfile: path.join(apiOut, 'reset-pin.js') });

fs.writeFileSync(
  path.join(apiOut, 'package.json'),
  JSON.stringify(
    {
      name: 'glm-api',
      version: '0.1.0',
      private: true,
      main: 'server.js',
      scripts: {
        start: 'node server.js',
        postinstall: 'prisma generate --schema=prisma/schema.prisma',
        'db:push': 'prisma db push --schema=prisma/schema.prisma',
        'db:seed-admin': 'node seed-admin.js',
        'db:reset-pin': 'node reset-pin.js',
      },
      dependencies: { '@prisma/client': PRISMA_VERSION, prisma: PRISMA_VERSION },
      // Newer npm versions block dependency install scripts by default;
      // Prisma needs its own to fetch the query engine.
      allowScripts: { [`@prisma/client@${PRISMA_VERSION}`]: true, [`@prisma/engines@${PRISMA_VERSION}`]: true, [`prisma@${PRISMA_VERSION}`]: true },
    },
    null,
    2,
  ) + '\n',
);

const schema = fs.readFileSync(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
// The dev schema pins the generator's output path (a workaround for the
// monorepo install); in this slim app root @prisma/client is installed
// normally and Prisma refuses to generate into it, so use the default.
const flipped = schema
  .replace(/(datasource db \{\s*provider = )"[a-z]+"/, '$1"postgresql"')
  .replace(/\r?\n[ \t]*\/\/ Pinned explicitly[\s\S]*?output\s*=\s*"[^"]*"/, '');
if (!flipped.includes('provider = "postgresql"')) throw new Error('Could not flip the datasource provider to postgresql');
if (/^\s*output\s*=/m.test(flipped)) throw new Error('Generator output pin was not stripped from the deploy schema');
fs.writeFileSync(path.join(apiOut, 'prisma', 'schema.prisma'), flipped);

// ── Web ───────────────────────────────────────────────────────────────────
execSync('npm run build -w apps/web', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_API_URL: API_URL } });
fs.cpSync(path.join(root, 'apps/web/dist'), webOut, { recursive: true });
fs.writeFileSync(
  path.join(webOut, '.htaccess'),
  `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
`,
);

console.log(`\nBuilt deploy/api (server.js ${(fs.statSync(path.join(apiOut, 'server.js')).size / 1024).toFixed(0)} KB) and deploy/web (API: ${API_URL}).`);
