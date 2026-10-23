import type { Prisma } from '@prisma/client';
import { STAGE_QUALITY, STAGE_READY } from '@glm/shared';
import { prisma } from './db';
import { getSummarySettings } from './daySummary';

// Automatic quality check: while the business has nobody to inspect, a finished job goes straight from Production to "Ready for Pickup/Delivery". The switch is in Day close → Order release rules.
// Each such order still gets a Quality record (marked automatic, in the name of whoever received it) so the history shows it was not inspected; automatic records are left out of pass rates.

export const AUTO_CHECK_NOTE = 'Passed automatically — quality inspection is switched off for now';

export async function qualityIsAutomatic(): Promise<boolean> {
  return (await getSummarySettings()).autoQualityCheck;
}

/** Passes an order waiting in Quality Check without an inspection: records it as automatic and makes it ready for the customer. */
export async function autoPassOrder(db: Prisma.TransactionClient, orderId: number, taskId: number | null, byUserId: number): Promise<void> {
  await db.qualityCheck.create({ data: { orderId, taskId, inspectorId: byUserId, result: 'Passed', auto: true, note: AUTO_CHECK_NOTE } });
  await db.order.update({ where: { id: orderId }, data: { stage: STAGE_READY } });
}

/** When the switch is on, passes every order already waiting in Quality Check. Returns how many were moved on. */
export async function sweepWaitingQuality(byUserId: number): Promise<number> {
  if (!(await qualityIsAutomatic())) return 0;
  const waiting = await prisma.order.findMany({ where: { status: { not: 'Quote' }, stage: STAGE_QUALITY }, select: { id: true } });
  for (const o of waiting) {
    const task = await prisma.productionTask.findFirst({ where: { orderId: o.id, status: 'Finished' }, orderBy: { finishedAt: 'desc' }, select: { id: true } });
    await prisma.$transaction((tx) => autoPassOrder(tx, o.id, task?.id ?? null, byUserId));
  }
  return waiting.length;
}
