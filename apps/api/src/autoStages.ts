import type { NextFunction, Request, Response } from 'express';
import { ACTIVE_TASK_STATUSES, STAGE_IN_PRODUCTION, STAGE_QUALITY, STAGE_WAITING } from '@glm/shared';
import { prisma } from './db';
import { getSummarySettings } from './daySummary';
import { autoPassOrder, sweepWaitingQuality } from './qualityAuto';
import { priceApprovalPending } from './routes/orders';

// Automatic production and quality: while the business has no one for these steps (Day close → Order release rules), an order passes through them by itself. With production automatic a captured
// order (not a quotation, and not held for a price approval) moves from "Order Received" straight on to Quality Check — no one assigns or finishes a job. With quality also automatic it goes on to
// Ready for Pickup/Delivery, recorded as an automatic pass. The moves are made as soon as anyone next touches the system (see automaticStages), and when the switches are saved.

let running: Promise<{ produced: number; passed: number }> | null = null;

async function sweep(): Promise<{ produced: number; passed: number }> {
  const s = await getSummarySettings();
  if (!s.autoProduction && !s.autoQualityCheck) return { produced: 0, passed: 0 };
  // The automatic record needs a person to stand in for the inspector: the Admin.
  const admin = await prisma.user.findFirst({ where: { role: 'Admin' }, orderBy: { id: 'asc' }, select: { id: true } });
  if (!admin) return { produced: 0, passed: 0 };
  let produced = 0;
  if (s.autoProduction) {
    // Waiting for a job to be assigned: nobody is actually on it (an order sent back by a failed inspection, with no job to redo, also lands here).
    const waiting = await prisma.order.findMany({
      where: { status: { not: 'Quote' }, stage: { in: [STAGE_WAITING, STAGE_IN_PRODUCTION] }, productionTasks: { none: { status: { in: ACTIVE_TASK_STATUSES } } } },
      select: { id: true, dtfArtworkJob: { select: { approvalStatus: true } }, embroideryJob: { select: { approvalStatus: true } } },
    });
    for (const o of waiting) {
      if (priceApprovalPending(o)) continue; // held until a manager approves the price
      await prisma.$transaction(async (tx) => {
        if (s.autoQualityCheck) await autoPassOrder(tx, o.id, null, admin.id);
        else await tx.order.update({ where: { id: o.id }, data: { stage: STAGE_QUALITY } });
      });
      produced++;
    }
  }
  const passed = s.autoQualityCheck ? await sweepWaitingQuality(admin.id) : 0;
  return { produced, passed };
}

/** Moves on every order that should pass through an automatic step. Safe to call at any time; concurrent calls share one run. */
export function sweepAutomaticStages() {
  if (!running) running = sweep().finally(() => (running = null));
  return running;
}

/** Runs before a request, so whoever looks next (or takes a payment, or hands over) sees each order at the stage it should be at. A failure here never stops the request. */
export async function automaticStages(_req: Request, _res: Response, next: NextFunction) {
  try {
    await sweepAutomaticStages();
  } catch (e) {
    console.error('automatic stages', e);
  }
  next();
}
