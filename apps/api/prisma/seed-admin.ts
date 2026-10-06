import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PIN_LONG, isWeakPin } from '@glm/shared';
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
  let pin = '';
  do pin = String(crypto.randomInt(0, 10 ** PIN_LONG)).padStart(PIN_LONG, '0');
  while (isWeakPin(pin));
  const pinHash = await bcrypt.hash(pin, 10);
  const admin = await prisma.user.create({ data: { name, role: 'Admin', pinHash, pinLength: PIN_LONG } });

  console.log(`Created Admin user "${admin.name}" (id ${admin.id}) — PIN: ${pin}`);
  console.log(
    'Keep this PIN somewhere safe — log in with it, then add whoever should really hold Admin access under Master Data → Staff & Users. ' +
      `To enable "Forgot PIN?" by email: node reset-pin.js "${admin.name}" --email you@example.com`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
