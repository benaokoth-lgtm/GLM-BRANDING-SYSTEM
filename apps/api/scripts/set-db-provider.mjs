import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Prisma's `provider` in the datasource block must be a static string literal — it can't be
// env-driven the way `url` can — so schema.prisma can only ever declare one database flavor at
// a time. Local dev uses sqlite (zero-setup, and the file the real business data has been
// entered into so far); the cPanel production deploy uses postgresql (see DEPLOYMENT.md and
// schema.prisma's own datasource comment). Rather than maintaining two copies of the schema
// (every model change would need to land in both, and they will drift), this script flips the
// one datasource line in place — .cpanel.yml runs it once, right before `npm install`, so
// Prisma's postinstall `prisma generate` produces a postgresql-flavored client on the server.
// The file committed to git always stays at the sqlite default (this script is never run
// against the repo you develop in, only on the cPanel clone).

const provider = process.argv[2];
if (provider !== 'sqlite' && provider !== 'postgresql') {
  console.error('Usage: node scripts/set-db-provider.mjs <sqlite|postgresql>');
  process.exit(1);
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma');
const content = readFileSync(schemaPath, 'utf8');
const updated = content.replace(/(datasource db \{[\s\S]*?provider\s*=\s*)"(?:sqlite|postgresql)"/, `$1"${provider}"`);

if (updated === content && !content.includes(`provider = "${provider}"`)) {
  console.error('Could not find the datasource provider line to replace in schema.prisma');
  process.exit(1);
}

writeFileSync(schemaPath, updated);
console.log(`prisma/schema.prisma datasource provider set to "${provider}"`);
