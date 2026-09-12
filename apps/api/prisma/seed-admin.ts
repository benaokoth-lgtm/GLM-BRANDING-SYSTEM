import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

// A fresh production database has no login at all — this creates exactly one
// Admin user (no Role row needed; 'Admin' is always all-permissions by
// server rule, see apps/api/src/permissions.ts) with a freshly random PIN,
// printed once so it can be captured. Deliberately NOT the full seed.ts:
// that script wipes every table and recreates a whole demo dataset (fake
// staff, hardcoded hand-typed PINs like "9999", and catalog defaults that
// predate this app's current Master Data setup) — fine for local dev, wrong
// for a real production system meant to start with nothing but real data
// staff enter themselves under Master Data.
async function main() {
  const existingAdmin = await prisma.user.findFirst({ where: { role: 'Admin' } });
  if (existingAdmin) {
    console.log(`An Admin user already exists (${existingAdmin.name}) — nothing to do.`);
    return;
  }

  const name = process.argv[2] || 'Admin';
  const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const pinHash = await bcrypt.hash(pin, 10);
  const admin = await prisma.user.create({ data: { name, role: 'Admin', pinHash } });

  console.log(`Created Admin user "${admin.name}" (id ${admin.id}) — PIN: ${pin}`);
  console.log(
    'There is no PIN-reset or staff-removal feature yet, so keep this PIN somewhere safe — ' +
      'log in with it, then add whoever should really hold Admin access under Master Data → Staff & Users.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
