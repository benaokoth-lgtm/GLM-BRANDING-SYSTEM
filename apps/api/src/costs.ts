import { DEFAULT_ROLE_PERMISSIONS } from '@glm/shared';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

// Who may see supplier costs and mark-ups on outsourced jobs. Everyone else sees selling prices only — the server withholds the cost
// fields from what it sends (and ignores them if they send any), it is not just hidden on screen.

export async function canSeeCosts(role: string): Promise<boolean> {
  return role === 'Admin' || (await permissionsForRole(role)).canSeeCosts;
}

/** Grants the permission once, on databases that pre-date it, to the roles that would normally have it. */
export async function ensureCostAccess(): Promise<void> {
  if ((await prisma.role.count({ where: { canSeeCosts: true } })) > 0) return;
  for (const name of ['Finance Manager', 'General Manager']) {
    if (DEFAULT_ROLE_PERMISSIONS[name]?.canSeeCosts) await prisma.role.updateMany({ where: { name }, data: { canSeeCosts: true } });
  }
}

let ensuring: Promise<void> | null = null;
export function ensureCostAccessOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureCostAccess().finally(() => (ensuring = null));
  return ensuring;
}

export interface CostFields {
  supplierName?: string | null;
  supplierCost?: number | null;
  markupType?: string | null;
  markupValue?: number | null;
}

/** The cost fields to store for a line: kept for people who can see costs, on service lines only; dropped for everyone else. */
export function costFieldsFor(li: CostFields & { itemType: string }, allowed: boolean): Required<CostFields> {
  if (!allowed || li.itemType === 'material') return { supplierName: null, supplierCost: null, markupType: null, markupValue: null };
  return {
    supplierName: li.supplierName?.trim() || null,
    supplierCost: li.supplierCost != null && li.supplierCost >= 0 ? li.supplierCost : null,
    markupType: li.markupType === 'amount' ? 'amount' : li.supplierCost != null || li.markupValue != null ? 'percent' : null,
    markupValue: li.markupValue != null && li.markupValue >= 0 ? li.markupValue : null,
  };
}
