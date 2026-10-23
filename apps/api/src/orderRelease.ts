// Releasing an order: the final payment and the handover happen together, at the counter, once the order is READY (produced and through quality control). A deposit or part-payment can be taken at any
// stage; the payment that settles the order, and the handover, are not taken earlier unless a manager releases it on purpose, with a reason — which is recorded and listed on Day close.
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

export const STAGE_READY = 'Ready for Pickup/Delivery';
export const STAGE_DONE = 'Completed';

/** May this person release an order early (settle it, or hand it over, before it is ready)? The Admin, Finance, and the people who run Production. */
export async function mayRelease(user: { role: string }): Promise<boolean> {
  if (user.role === 'Admin') return true;
  const p = await permissionsForRole(user.role);
  return p.canAccessFinance || p.canManageProduction;
}

/** Is the "ready before the final payment" rule switched on? (On unless an Admin has switched it off under Day close → Set-up.) */
export async function readyGateOn(): Promise<boolean> {
  const s = await prisma.dayCloseSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return s.readyBeforeFinalPayment;
}

export async function logOverride(db: Prisma.TransactionClient | typeof prisma, o: { orderId: number; orderNo: string; kind: 'FinalPayment' | 'Handover'; stage: string; amount?: number; reason: string; byName: string }) {
  await db.orderOverride.create({ data: { orderId: o.orderId, orderNo: o.orderNo, kind: o.kind, stage: o.stage, amount: o.amount ?? 0, reason: o.reason.slice(0, 300), byName: o.byName } });
}
