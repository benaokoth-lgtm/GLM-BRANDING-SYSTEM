import { DEFAULT_BUSINESS_HEADS, DEFAULT_ROLE_PERMISSIONS, defaultBusinessHeadName, formatPurchaseOrderRef, nextPurchaseOrderNumber } from '@glm/shared';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

// Purchases have a purchase-order reference (PO-0001…) and any number of lines. Older purchases were one material with no
// reference; on start-up (and before any purchase is listed) each is given the next free reference and its material becomes its
// first line. Safe to run any number of times.

export async function nextPoNumber(): Promise<number> {
  const rows = await prisma.purchase.findMany({ where: { poRef: { not: null } }, select: { poRef: true } });
  return nextPurchaseOrderNumber(rows.map((r) => r.poRef));
}

export async function ensurePurchases(): Promise<void> {
  const rows = await prisma.purchase.findMany({ include: { lines: true }, orderBy: { id: 'asc' } });
  let next = await nextPoNumber();
  for (const p of rows) {
    if (!p.poRef) await prisma.purchase.update({ where: { id: p.id }, data: { poRef: formatPurchaseOrderRef(next++) } });
    if (p.lines.length === 0 && p.materialId) {
      // Stock was increased by the whole quantity when an old purchase was accepted, so that is what was "received".
      await prisma.purchaseLine.create({
        data: { purchaseId: p.id, materialId: p.materialId, qty: p.qty, unitCost: p.unitCost, totalCost: p.totalCost, receivedQty: p.status === 'Accepted' ? p.qty : null },
      });
    }
  }
}

let ensuringPurchases: Promise<void> | null = null;
export function ensurePurchasesOnce(): Promise<void> {
  if (!ensuringPurchases) ensuringPurchases = ensurePurchases().finally(() => (ensuringPurchases = null));
  return ensuringPurchases;
}

// ── Who may receive goods into the store ────────────────────────────────────

export async function canReceiveStock(role: string): Promise<boolean> {
  if (role === 'Admin') return true;
  const p = await permissionsForRole(role);
  return p.canReceiveStock || p.canApproveStock;
}

/** Grants the permission once, on databases that pre-date it, to the roles that would normally have it. */
export async function ensureStoresAccess(): Promise<void> {
  if ((await prisma.role.count({ where: { canReceiveStock: true } })) > 0) return;
  for (const name of ['Supervisor', 'Finance Manager', 'General Manager']) {
    if (DEFAULT_ROLE_PERMISSIONS[name]?.canReceiveStock) await prisma.role.updateMany({ where: { name }, data: { canReceiveStock: true } });
  }
}

// ── Business heads ──────────────────────────────────────────────────────────

/** Makes sure the standard business heads exist and that every service belongs to one (picked from its name until someone chooses). */
export async function ensureBusinessHeads(): Promise<void> {
  const existing = await prisma.businessHead.findMany();
  const byName = new Map(existing.map((h) => [h.name, h]));
  let order = existing.reduce((a, h) => Math.max(a, h.sortOrder), 0);
  for (const name of DEFAULT_BUSINESS_HEADS) {
    if (!byName.has(name)) {
      byName.set(name, await prisma.businessHead.create({ data: { name, sortOrder: ++order } }));
    }
  }
  for (const s of await prisma.service.findMany({ where: { businessHeadId: null } })) {
    const head = byName.get(defaultBusinessHeadName(s.name));
    if (head) await prisma.service.update({ where: { id: s.id }, data: { businessHeadId: head.id } });
  }
}

let ensuringHeads: Promise<void> | null = null;
export function ensureBusinessHeadsOnce(): Promise<void> {
  if (!ensuringHeads) ensuringHeads = ensureBusinessHeads().finally(() => (ensuringHeads = null));
  return ensuringHeads;
}
