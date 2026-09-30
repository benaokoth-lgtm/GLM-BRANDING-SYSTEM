import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

// Out-of-band PIN recovery for when nobody can log in (there's no in-app
// reset, and a forgotten Admin PIN otherwise needs direct database edits).
// Also clears any failed-attempt lockout, which is the other common reason a
// correct PIN "doesn't work".
//
//   node reset-pin.js "Name"            -> sets a fresh random 4-digit PIN
//   node reset-pin.js "Name" 1234       -> sets that PIN
//   node reset-pin.js --list            -> lists users (id, name, role, lock status)
async function main() {
  const [nameArg, pinArg] = process.argv.slice(2);

  if (!nameArg || nameArg === '--list') {
    const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    for (const u of users) {
      const locked = u.lockedUntil && u.lockedUntil > new Date() ? ` — LOCKED until ${u.lockedUntil.toISOString()}` : '';
      console.log(`${u.id}\t${u.name}\t${u.role}\tfailed attempts: ${u.failedLoginCount}${locked}`);
    }
    if (!nameArg) console.log('\nUsage: node reset-pin.js "Name" [4-digit PIN]');
    return;
  }

  if (pinArg !== undefined && !/^\d{4}$/.test(pinArg)) {
    console.error('The PIN must be exactly 4 digits (e.g. 0427).');
    process.exit(1);
  }

  const matches = await prisma.user.findMany({ where: { name: nameArg } });
  if (matches.length === 0) {
    console.error(`No user named "${nameArg}". Run with --list to see who exists.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`More than one user is named "${nameArg}" — rename one in the app first.`);
    process.exit(1);
  }

  const user = matches[0]!;
  const pin = pinArg ?? String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const pinHash = await bcrypt.hash(pin, 10);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash, failedLoginCount: 0, lockedUntil: null } });
  console.log(`PIN for "${user.name}" (${user.role}) is now: ${pin}  (any lockout was cleared)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
