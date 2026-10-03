// Runs the API tests against a throwaway SQLite database, never the dev one:
//   npm run test -w apps/api
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(root, 'prisma', 'test.db');
for (const f of [dbFile, `${dbFile}-journal`]) fs.rmSync(f, { force: true });

const env = { ...process.env, DATABASE_URL: 'file:./test.db', NODE_ENV: 'test' };
execSync('npx prisma db push --skip-generate --accept-data-loss', { cwd: root, stdio: 'inherit', env });
execSync('npx tsx --test tests/*.test.ts', { cwd: root, stdio: 'inherit', env });
fs.rmSync(dbFile, { force: true });
