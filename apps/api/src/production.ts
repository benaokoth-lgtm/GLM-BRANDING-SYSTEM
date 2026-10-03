import { buildLineTotal, computeOrderTotals, DEFAULT_ROLE_PERMISSIONS, orderUnits } from '@glm/shared';
import type { LineItemInput, PaymentRecord } from '@glm/shared';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

// Shared pieces of the Production and Quality routes.

/** Grants the production/quality permissions, once, on databases that pre-date them (Master Data → Roles is the source of truth afterwards). */
export async function ensureProduction(): Promise<void> {
  if ((await prisma.role.count({ where: { OR: [{ canAccessProduction: true }, { canManageProduction: true }, { canAccessQuality: true }] } })) > 0) return;
  for (const name of ['Staff', 'Supervisor', 'Finance Manager', 'General Manager']) {
    const d = DEFAULT_ROLE_PERMISSIONS[name];
    if (!d) continue;
    await prisma.role.updateMany({ where: { name }, data: { canAccessProduction: d.canAccessProduction, canManageProduction: d.canManageProduction, canAccessQuality: d.canAccessQuality } });
  }
}

let ensuring: Promise<void> | null = null;
export function ensureProductionOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureProduction().finally(() => (ensuring = null));
  return ensuring;
}

export async function isProductionManager(user: { role: string }): Promise<boolean> {
  return user.role === 'Admin' || (await permissionsForRole(user.role)).canManageProduction;
}

/** Can this user be given jobs? Anyone in Production (or Admin) — managers can also be assigned work. */
export async function canWorkProduction(role: string): Promise<boolean> {
  if (role === 'Admin') return true;
  const p = await permissionsForRole(role);
  return p.canAccessProduction || p.canManageProduction;
}

export const orderForProductionInclude = {
  lineItems: { include: { service: true, material: true } },
  payments: true,
  corporateClient: true,
} as const;

type OrderWithLines = {
  id: number;
  orderNo: string;
  kind: string;
  channel: string;
  status: string;
  stage: string;
  customerName: string | null;
  createdDate: string;
  dueDate: string | null;
  orderDiscountPct: number;
  orderDiscountAmt: number;
  corporateClient: { name: string } | null;
  lineItems: { itemType: string; serviceId: number | null; materialId: number | null; qty: number; unitPrice: number; discountPct: number; discountAmt: number; heatPressFee: number | null; service: { name: string } | null; material: { name: string } | null }[];
  payments: { date: string; amount: number; method: string }[];
};

/** What Production and Quality need to know about an order: who it is for, what is on it, how much work, and whether it is paid for. */
export function productionSummary(o: OrderWithLines) {
  const lines: LineItemInput[] = o.lineItems.map((li) => ({
    itemType: li.itemType as LineItemInput['itemType'],
    serviceId: li.serviceId,
    materialId: li.materialId,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountAmt: li.discountAmt,
    heatPressFee: li.heatPressFee,
  }));
  const totals = computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }, o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] })));
  void buildLineTotal;
  return {
    orderId: o.id,
    orderNo: o.orderNo,
    customer: o.customerName || o.corporateClient?.name || 'Customer',
    channel: o.channel,
    status: o.status,
    stage: o.stage,
    createdDate: o.createdDate,
    dueDate: o.dueDate,
    items: o.lineItems.map((li) => ({ name: li.material?.name ?? li.service?.name ?? 'Item', qty: li.qty })),
    units: orderUnits(o.lineItems),
    balanceDue: Math.round(totals.balanceDue * 100) / 100,
  };
}
