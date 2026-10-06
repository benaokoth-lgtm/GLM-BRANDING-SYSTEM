import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { isWeakPin, pinProblem, requiredPinLength } from '@glm/shared';

const prisma = new PrismaClient();

// Out-of-band PIN recovery for when nobody can log in (there's no in-app
// reset, and a forgotten Admin PIN otherwise needs direct database edits).
// Also clears any failed-attempt lockout, which is the other common reason a
// correct PIN "doesn't work".
//
//   node reset-pin.js "Name"            -> sets a fresh random PIN (6 digits for the Admin and roles that handle money)
//   node reset-pin.js "Name" 1234       -> sets that PIN
//   node reset-pin.js --list            -> lists users (id, name, role, email, lock status)
//   node reset-pin.js "Name" --email a@b.com
//                                       -> sets the Admin's recovery email (PIN untouched)
//                                          used by "Forgot PIN?" on the login screen
async function main() {
  const args = process.argv.slice(2);
  const emailFlag = args.indexOf('--email');
  let emailArg: string | undefined;
  if (emailFlag !== -1) {
    emailArg = args[emailFlag + 1]?.trim().toLowerCase();
    args.splice(emailFlag, 2);
    if (!emailArg || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailArg)) {
      console.error('--email needs a valid address, e.g. --email you@example.com');
      process.exit(1);
    }
  }
  const [nameArg, pinArg] = args;

  if (!nameArg || nameArg === '--list') {
    const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    for (const u of users) {
      const locked = u.lockedUntil && u.lockedUntil > new Date() ? ` — LOCKED until ${u.lockedUntil.toISOString()}` : '';
      console.log(`${u.id}\t${u.name}\t${u.role}\t${u.email ?? '(no email)'}\tfailed attempts: ${u.failedLoginCount}${locked}${u.active ? '' : ' — SWITCHED OFF'}`);
    }
    if (!nameArg) console.log('\nUsage: node reset-pin.js "Name" [PIN, 4-6 digits]   |   node reset-pin.js "Name" --email you@example.com');
    return;
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

  if (emailArg) {
    if (user.role !== 'Admin') {
      console.error(`"${user.name}" is a ${user.role}; the recovery email is for the Admin only.`);
      process.exit(1);
    }
    const taken = await prisma.user.findUnique({ where: { email: emailArg } });
    if (taken && taken.id !== user.id) {
      console.error(`${emailArg} is already set on "${taken.name}".`);
      process.exit(1);
    }
    await prisma.user.update({ where: { id: user.id }, data: { email: emailArg } });
    console.log(`Recovery email for "${user.name}" is now ${emailArg}.`);
    // Email alone doesn't touch the PIN; only continue if a PIN was also given.
    if (pinArg === undefined) return;
  }

  // The Admin and any role that handles money, costs, pay or the books needs a 6-digit PIN; obvious PINs are refused.
  const roleRow = user.role === 'Admin' ? null : await prisma.role.findUnique({ where: { name: user.role } });
  const need = requiredPinLength(user.role, roleRow as Record<string, boolean> | null);
  let pin = pinArg ?? '';
  if (pinArg === undefined) {
    do pin = String(crypto.randomInt(0, 10 ** need)).padStart(need, '0');
    while (isWeakPin(pin));
  } else {
    const problem = pinProblem(pinArg, user.role, roleRow as Record<string, boolean> | null);
    if (problem) {
      console.error(problem + '.');
      process.exit(1);
    }
  }
  const pinHash = await bcrypt.hash(pin, 10);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash, pinLength: pin.length, failedLoginCount: 0, lockCount: 0, lockedUntil: null, tokenVersion: { increment: 1 } } });
  console.log(`PIN for "${user.name}" (${user.role}) is now: ${pin}  (any lockout was cleared)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
