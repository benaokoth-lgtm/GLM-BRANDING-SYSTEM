import { PERMISSION_KEYS } from '@glm/shared';
import type { Permissions } from '@glm/shared';
import { prisma } from './db';

const ALL_TRUE: Permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Permissions;
const ALL_FALSE: Permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Permissions;

// 'Admin' always gets every permission regardless of its stored Role row —
// the one fixed recovery path so a permissions mistake elsewhere can never
// lock every user out (see Role model docs in schema.prisma). Any other role
// name with no matching Role row (e.g. deleted out from under a stale user)
// safely falls back to no access rather than throwing.
export async function permissionsForRole(roleName: string): Promise<Permissions> {
  if (roleName === 'Admin') return ALL_TRUE;
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) return ALL_FALSE;
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, role[k]])) as Permissions;
}
