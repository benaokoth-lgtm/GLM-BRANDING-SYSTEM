import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { canCaptureForOthers, salesPeople } from '../frontOffice';
import { notifyApprovers } from '../approvals';
import { canAccessOrder } from './orders';

// Correcting who an order is credited to — when the sales person was forgotten at capture, or the wrong one was chosen. The order moves to the right person's list, and their commission and
// sales target follow it (commission is worked out from the money received on the orders credited to each person). Who keyed the order ("captured by") does not change.
//  • Admin and people who manage commission correct it straight away, with a reason.
//  • Anyone else involved (the front office, the person it is credited to, the person who keyed it) asks; one of the above approves it in the Approvals inbox.
// Every correction is kept, with who asked, who decided and why, as a trail on the order.
export const allocationRouter = Router();
allocationRouter.use(requireAuth);

/** May this person correct an allocation outright (and decide others' requests)? Admin, and those who manage commission. */
export async function mayCorrectAllocation(role: string): Promise<boolean> {
  return role === 'Admin' || (await permissionsForRole(role)).canManageCommission;
}

const monthOf = (date: string) => date.slice(0, 7);

/** Why an order cannot be moved to someone else: commission for a month it was paid in has already been approved, and would no longer match. */
async function lockProblem(orderId: number): Promise<string | null> {
  const payments = await prisma.payment.findMany({ where: { orderId }, select: { date: true } });
  const months = [...new Set(payments.map((p) => monthOf(p.date)))];
  if (months.length === 0) return null;
  const locked = await prisma.commissionPayout.findMany({ where: { period: { in: months } }, select: { period: true }, distinct: ['period'] });
  if (locked.length === 0) return null;
  const when = locked.map((l) => l.period).sort().join(', ');
  return `This order was paid in ${when}, and commission for that month has already been approved, so moving the order would no longer match what was approved. The month's approval has to be undone first (Commission → Team & payouts).`;
}

/** Moves the order to the new sales person and keeps the record. Throws a message when it cannot be done. */
async function apply(orderId: number, toId: number, who: { id: number; name: string }, reason: string, existingId?: number): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { staff: { select: { name: true } } } });
  if (!order) throw new Error('Order not found');
  if (order.staffId === toId) throw new Error('The order is already credited to that person');
  const to = (await salesPeople()).find((p) => p.id === toId);
  if (!to) throw new Error('That sales person cannot be found, or is not set up to be given orders');
  const lock = await lockProblem(orderId);
  if (lock) throw new Error(lock);
  await prisma.$transaction(async (tx) => {
    // a client credited to the same person the order was is moved with it; one credited to somebody else (the client's owner) stays theirs
    await tx.order.update({ where: { id: orderId }, data: { staffId: toId, ...(order.sourcedByStaffId === order.staffId ? { sourcedByStaffId: toId } : {}) } });
    if (existingId) await tx.allocationChange.update({ where: { id: existingId }, data: { status: 'Approved', decidedByName: who.name, decidedAt: new Date(), fromStaffId: order.staffId, fromName: order.staff.name } });
    else {
      await tx.allocationChange.create({
        data: { orderId, orderNo: order.orderNo, fromStaffId: order.staffId, fromName: order.staff.name, toStaffId: toId, toName: to.name, reason, requestedById: who.id, requestedByName: who.name, status: 'Approved', decidedByName: who.name, decidedAt: new Date() },
      });
    }
  });
}

// What the order's screen needs: who it is credited to, who it can be given to, whether the person may correct or only ask, what is already asked, and the trail.
allocationRouter.get('/orders/:orderId', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.orderId) }, include: { staff: { select: { id: true, name: true } } } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted for your role' });
  const [direct, others, people, rows] = await Promise.all([
    mayCorrectAllocation(req.user!.role),
    canCaptureForOthers(req.user!.role),
    salesPeople(),
    prisma.allocationChange.findMany({ where: { orderId: order.id }, orderBy: { id: 'desc' }, take: 20 }),
  ]);
  const involved = others || order.staffId === req.user!.id || order.capturedById === req.user!.id;
  const pending = rows.find((r) => r.status === 'Pending') ?? null;
  res.json({
    current: order.staff,
    people: people.filter((p) => p.id !== order.staffId).map((p) => ({ id: p.id, name: p.name })),
    direct,
    canAsk: !direct && involved,
    pending: pending ? { id: pending.id, toName: pending.toName, requestedByName: pending.requestedByName, reason: pending.reason, mine: pending.requestedById === req.user!.id } : null,
    history: rows.filter((r) => r.status !== 'Pending').map((r) => ({ id: r.id, status: r.status, fromName: r.fromName, toName: r.toName, reason: r.reason, requestedByName: r.requestedByName, decidedByName: r.decidedByName, decidedAt: r.decidedAt?.toISOString() ?? null })),
  });
});

const changeSchema = z.object({ staffId: z.number().int(), reason: z.string().trim().min(3, 'Say why the sales person is being changed').max(300) });

// Correct it (Admin / commission managers) or ask for the correction (anyone else involved in the order).
allocationRouter.post('/orders/:orderId', async (req, res) => {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.orderId) }, include: { staff: { select: { name: true } } } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted for your role' });
  const user = req.user!;
  const to = (await salesPeople()).find((p) => p.id === parsed.data.staffId);
  if (!to) return res.status(400).json({ error: 'That sales person cannot be found, or is not set up to be given orders' });
  if (order.staffId === to.id) return res.status(400).json({ error: 'The order is already credited to that person' });

  if (await mayCorrectAllocation(user.role)) {
    try {
      await apply(order.id, to.id, user, parsed.data.reason);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Could not change the sales person' });
    }
    return res.json({ ok: true, applied: true, staff: { id: to.id, name: to.name } });
  }
  const involved = (await canCaptureForOthers(user.role)) || order.staffId === user.id || order.capturedById === user.id;
  if (!involved) return res.status(403).json({ error: 'Only Admin, those who manage commission, or the people on the order can ask for this' });
  if (await prisma.allocationChange.findFirst({ where: { orderId: order.id, status: 'Pending' } })) return res.status(400).json({ error: 'A correction for this order is already waiting for approval' });
  const lock = await lockProblem(order.id);
  if (lock) return res.status(400).json({ error: lock });
  const row = await prisma.allocationChange.create({
    data: { orderId: order.id, orderNo: order.orderNo, fromStaffId: order.staffId, fromName: order.staff.name, toStaffId: to.id, toName: to.name, reason: parsed.data.reason, requestedById: user.id, requestedByName: user.name },
  });
  notifyApprovers('allocation', `${order.orderNo}: sales person ${order.staff.name} → ${to.name}`, `${user.name} asks to change the sales person on order ${order.orderNo} from ${order.staff.name} to ${to.name}. Reason: ${parsed.data.reason}`, { id: user.id });
  res.status(201).json({ ok: true, applied: false, requestId: row.id });
});

async function decide(req: Request, res: Response, approve: boolean) {
  if (!(await mayCorrectAllocation(req.user!.role))) return res.status(403).json({ error: 'Only Admin or those who manage commission can decide this' });
  const row = await prisma.allocationChange.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Correction request not found' });
  if (row.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${row.status === 'Approved' ? 'approved' : 'turned down'}` });
  if (row.requestedById === req.user!.id) return res.status(400).json({ error: 'You cannot decide your own request' });
  if (approve) {
    const order = await prisma.order.findUnique({ where: { id: row.orderId } });
    if (!order) return res.status(400).json({ error: 'The order no longer exists' });
    if (order.staffId !== row.fromStaffId) return res.status(400).json({ error: `The order is now credited to someone else (it was changed since this was asked). Turn this request down and ask again.` });
    try {
      await apply(row.orderId, row.toStaffId, req.user!, row.reason, row.id);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Could not change the sales person' });
    }
    return res.json({ ok: true });
  }
  const note = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  await prisma.allocationChange.update({ where: { id: row.id }, data: { status: 'Rejected', decidedByName: req.user!.name, decidedAt: new Date(), decisionNote: note } });
  res.json({ ok: true });
}
allocationRouter.post('/requests/:id/approve', (req, res) => decide(req, res, true));
allocationRouter.post('/requests/:id/reject', (req, res) => decide(req, res, false));
