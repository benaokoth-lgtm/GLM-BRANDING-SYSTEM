// PIN policy on the server: how long a PIN must be for a role, picking a strong random one, and the escalating lock-out after wrong PINs.
import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { PIN_LONG, isWeakPin, pinProblem, requiredPinLength } from '@glm/shared';
import { prisma } from './db';
import { writeAudit } from './audit';

export const PIN_ROUNDS = 10;
const MAX_ATTEMPTS = 5; // wrong PINs in a row before a lock
const BASE_LOCK_MINUTES = 15; // the first lock; each further lock doubles it …
const MAX_LOCK_MINUTES = 24 * 60; // … up to a day
const QUIET_RESET_MS = 24 * 3600 * 1000; // a day without a wrong PIN forgets earlier locks

async function permissionsOfRole(roleName: string) {
  return roleName === 'Admin' ? null : prisma.role.findUnique({ where: { name: roleName } });
}

/** How many digits this role's PIN must have at least. */
export async function requiredLengthFor(roleName: string): Promise<number> {
  if (roleName === 'Admin') return PIN_LONG;
  return requiredPinLength(roleName, (await permissionsOfRole(roleName)) as Record<string, boolean> | null);
}

/** Why this PIN cannot be used for this role, or null. */
export async function pinProblemFor(pin: string, roleName: string): Promise<string | null> {
  return pinProblem(pin, roleName, (await permissionsOfRole(roleName)) as Record<string, boolean> | null);
}

/** A random PIN of the given length that is not an obvious one. */
export function randomPin(length: number): string {
  for (;;) {
    const pin = String(crypto.randomInt(0, 10 ** length)).padStart(length, '0');
    if (!isWeakPin(pin)) return pin;
  }
}

/**
 * A wrong PIN. After five in a row the person is locked out — 15 minutes the first time, then 30, 60, 120 … up to a day for every further
 * lock (until a quiet day or a correct PIN). That keeps a real person who mistyped waiting only a quarter of an hour, while guessing a PIN
 * at the rate the lock allows would take years.
 */
export async function registerFailedPin(user: User, ip = ''): Promise<{ lockedMinutes: number | null }> {
  const now = new Date();
  const quiet = !user.lastFailedAt || now.getTime() - user.lastFailedAt.getTime() > QUIET_RESET_MS;
  const lockCount = quiet ? 0 : user.lockCount;
  const failed = (quiet ? 0 : user.failedLoginCount) + 1;
  if (failed >= MAX_ATTEMPTS) {
    const minutes = Math.min(MAX_LOCK_MINUTES, BASE_LOCK_MINUTES * 2 ** lockCount);
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockCount: lockCount + 1, lockedUntil: new Date(now.getTime() + minutes * 60_000), lastFailedAt: now } });
    await writeAudit({ userId: user.id, userName: user.name, role: user.role, method: 'AUTH', action: `LOCKED OUT for ${minutes} minutes after wrong PINs`, ip });
    return { lockedMinutes: minutes };
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: failed, lockCount, lastFailedAt: now } });
  return { lockedMinutes: null };
}

export async function clearPinFailures(userId: number): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockCount: 0, lockedUntil: null } });
}

export const minutesLeft = (until: Date) => Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
