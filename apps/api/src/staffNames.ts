import { splitName } from '@glm/shared';
import { prisma } from './db';

/**
 * Staff added before names were captured in three parts have only a full name. Fill their first / middle / surname from it, once: first word →
 * first name, last word → surname, anything between → middle name. A one-word name (say "BEN") gets a first name only; the Admin completes the
 * surname under Master Data → Staff & Users. Anyone who already has a first name is left as they are.
 */
export async function ensureStaffNames(): Promise<void> {
  const users = await prisma.user.findMany({ where: { firstName: '' }, select: { id: true, name: true } });
  for (const u of users) {
    const p = splitName(u.name);
    if (!p.firstName) continue;
    await prisma.user.update({ where: { id: u.id }, data: p });
  }
}

let ensuring: Promise<void> | null = null;
export function ensureStaffNamesOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureStaffNames().finally(() => (ensuring = null));
  return ensuring;
}
