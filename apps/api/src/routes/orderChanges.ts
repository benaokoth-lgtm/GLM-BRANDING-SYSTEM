import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { computeOrderTotals, round2, todayStr } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { canSeeCosts, costFieldsFor } from '../costs';
import { returnOrderStock, takeOrderStock } from '../orderStock';
import { notifyApprovers } from '../approvals';
import { canAccessOrder, lineItemSchema, orderInclude, resolveWalkinStatus, serializeDetail } from './orders';
import type { FullOrder } from './orders';

// Amending or deleting an order after it has been captured. Orders cannot simply be edited or removed: the books, the stock, the commission and the customer's paperwork all follow them. So:
//   1. the person who needs the change asks, with a reason (the order's salesperson, or the front office);
//   2. a manager (Finance, or the Admin) approves it in the Approvals inbox — never the person who asked, except the Admin;
//   3. then the SAME person makes the change, once: amending the lines, customer and discount, or deleting the order.
// Every step is kept, with what the order looked like before and after. Completed orders and orders Production has worked on are not amended; a mistaken one (a duplicate) can be deleted whatever its
// type if nothing real has happened to it. An order with payments cannot be deleted until its payments are moved to the right order or refunded (Accounting → M-Pesa Matching → Matched payments; credit notes).
export const orderChangesRouter = Router();
orderChangesRouter.use(requireAuth);

/** May this person decide requests? Finance (the people who approve expense corrections) and the Admin. */
async function mayDecide(role: string): Promise<boolean> {
  return role === 'Admin' || (await permissionsForRole(role)).canAccessFinance;
}

const KIND_WORD = { Amend: 'amendment', Delete: 'deletion' } as const;

function view(r: Awaited<ReturnType<typeof prisma.orderChange.findMany>>[number], userId: number) {
  return {
    id: r.id,
    orderId: r.orderId,
    orderNo: r.orderNo,
    kind: r.kind as 'Amend' | 'Delete',
    reason: r.reason,
    status: r.status,
    requestedByName: r.requestedByName,
    requestedAt: r.requestedAt.toISOString(),
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    doneAt: r.doneAt?.toISOString() ?? null,
    mine: r.requestedById === userId,
  };
}

/** Why this order cannot be AMENDED here (null when it can). */
function amendProblem(order: FullOrder): string | null {
  if (order.dtfFilmSale || order.dtfArtworkJob || order.embroideryJob) return 'Film, artwork and embroidery orders are tied to the roll and the job, so they cannot be amended here (a mistaken one can be deleted instead)';
  if (order.stage === 'Completed' || order.handedOverOnCredit) return 'A completed order cannot be amended — raise a credit note instead';
  return null;
}

/**
 * Why this order cannot be DELETED (null when it can). A mistaken order — a duplicate — can be deleted whatever its type and even if it was wrongly marked Completed, as long as nothing real
 * has happened to it: no payment taken, no credit note, no supplier bill, and Production has not worked on it. Otherwise a credit note is the way to undo it.
 */
async function deleteProblem(order: FullOrder): Promise<string | null> {
  const worked = await prisma.productionTask.count({ where: { orderId: order.id, status: { in: ['In Progress', 'Finished'] } } });
  const checked = await prisma.qualityCheck.count({ where: { orderId: order.id } });
  if (worked > 0 || checked > 0) return 'Production has already worked on this order, so it cannot be deleted — raise a credit note instead';
  if ((await prisma.expense.count({ where: { orderId: order.id } })) > 0) return 'A supplier bill has been recorded against this order, so it cannot be deleted';
  if ((await prisma.adjustmentNote.count({ where: { orderId: order.id } })) > 0) return 'A credit or debit note has been raised against this order, so it cannot be deleted';
  return null;
}

const snapshot = (o: FullOrder) => {
  const totals = computeOrderTotals({ lineItems: o.lineItems as unknown as LineItemInput[], orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }, o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as 'Cash' })));
  return JSON.stringify({
    customerName: o.customerName,
    phone: o.phone,
    status: o.status,
    orderDiscountPct: o.orderDiscountPct,
    orderDiscountAmt: o.orderDiscountAmt,
    total: round2(totals.grandTotal),
    paid: round2(totals.paidTotal),
    lines: o.lineItems.map((li) => ({ item: li.service?.name ?? li.material?.name ?? 'Item', qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee, description: li.description })),
  });
};

// ── What has been asked of an order, and what this person may do next ─────────────────────────────────
orderChangesRouter.get('/orders/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const rows = await prisma.orderChange.findMany({ where: { orderId }, orderBy: { id: 'desc' }, take: 20 });
  res.json({ requests: rows.map((r) => view(r, req.user!.id)), amendProblem: amendProblem(order), deleteProblem: await deleteProblem(order), hasPayments: order.payments.length > 0 });
});

const askSchema = z.object({ kind: z.enum(['Amend', 'Delete']), reason: z.string().trim().min(3, 'Say why the order needs to be changed').max(300) });

orderChangesRouter.post('/orders/:orderId', async (req, res) => {
  const body = askSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Give a reason' });
  const orderId = Number(req.params.orderId);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const problem = body.data.kind === 'Amend' ? amendProblem(order) : await deleteProblem(order);
  if (problem) return res.status(400).json({ error: problem });
  const open = await prisma.orderChange.findFirst({ where: { orderId, status: { in: ['Pending', 'Approved'] } } });
  if (open) return res.status(409).json({ error: `There is already ${open.status === 'Pending' ? 'a request waiting for approval' : 'an approved request not used yet'} for this order` });
  const row = await prisma.orderChange.create({
    data: { orderId, orderNo: order.orderNo, customer: order.corporateClient?.name || order.customerName || '', kind: body.data.kind, reason: body.data.reason, requestedById: req.user!.id, requestedByName: req.user!.name },
  });
  notifyApprovers('orderchange', `Order ${order.orderNo}: ${KIND_WORD[body.data.kind]} requested`, `${req.user!.name} asks to ${body.data.kind === 'Amend' ? 'amend' : 'delete'} order ${order.orderNo} (${row.customer || 'customer'}). Reason: ${body.data.reason}`, { id: req.user!.id, name: req.user!.name });
  res.status(201).json(view(row, req.user!.id));
});

// ── The decision ─────────────────────────────────────────────────────────────────────────────────────
async function decide(req: Request, res: Response, approve: boolean) {
  if (!(await mayDecide(req.user!.role))) return res.status(403).json({ error: 'Only Finance or the Admin decide requests to change an order' });
  const row = await prisma.orderChange.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status !== 'Pending') return res.status(409).json({ error: 'That request has already been dealt with' });
  if (row.requestedById === req.user!.id && req.user!.role !== 'Admin') return res.status(403).json({ error: 'Someone other than the person who asked decides it' });
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  const saved = await prisma.orderChange.update({ where: { id: row.id }, data: { status: approve ? 'Approved' : 'Rejected', decidedByName: req.user!.name, decidedAt: new Date(), decisionNote: note } });
  res.json(view(saved, req.user!.id));
}
orderChangesRouter.post('/requests/:id/approve', (req, res) => decide(req, res, true));
orderChangesRouter.post('/requests/:id/reject', (req, res) => decide(req, res, false));

orderChangesRouter.post('/requests/:id/cancel', async (req, res) => {
  const row = await prisma.orderChange.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.requestedById !== req.user!.id) return res.status(403).json({ error: 'Only the person who asked can withdraw it' });
  if (row.status !== 'Pending' && row.status !== 'Approved') return res.status(409).json({ error: 'That request is already closed' });
  await prisma.orderChange.update({ where: { id: row.id }, data: { status: 'Cancelled' } });
  res.json({ ok: true });
});

/** The approved request this person may use on this order, once. */
async function approvedFor(userId: number, orderId: number, kind: 'Amend' | 'Delete') {
  return prisma.orderChange.findFirst({ where: { orderId, kind, status: 'Approved', requestedById: userId }, orderBy: { id: 'desc' } });
}

// ── Amending ─────────────────────────────────────────────────────────────────────────────────────────
const amendSchema = z.object({
  customerName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  lineItems: z.array(lineItemSchema).min(1, 'An order needs at least one line'),
  orderDiscountPct: z.number().min(0).max(100).default(0),
  orderDiscountAmt: z.number().min(0).default(0),
});

orderChangesRouter.put('/orders/:orderId/amend', async (req, res) => {
  const body = amendSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
  const orderId = Number(req.params.orderId);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const request = await approvedFor(req.user!.id, orderId, 'Amend');
  if (!request) return res.status(403).json({ error: 'There is no approved request for you to amend this order. Ask for the amendment first, and wait for it to be approved.' });
  const problem = amendProblem(order);
  if (problem) return res.status(400).json({ error: problem });

  const d = body.data;
  const totals = computeOrderTotals({ lineItems: d.lineItems, orderDiscountPct: d.orderDiscountPct, orderDiscountAmt: d.orderDiscountAmt }, []);
  const paid = order.payments.reduce((a, p) => a + p.amount, 0);
  if (paid > totals.grandTotal + 0.01) {
    return res.status(400).json({ error: `The customer has already paid Ksh ${Math.round(paid).toLocaleString('en-KE')}, which is more than the new total of Ksh ${Math.round(totals.grandTotal).toLocaleString('en-KE')}. Refund or move the extra payment first (credit note, or Matched payments for M-Pesa).` });
  }
  const costs = await canSeeCosts(req.user!.role);
  const before = snapshot(order);
  const updated = await prisma.$transaction(async (tx) => {
    // the stock the order took goes back, and what the new lines need is taken (a quotation holds none)
    await returnOrderStock(tx, orderId);
    // supplier costing already on a line is kept when the new line is the same service
    const oldCosts = order.lineItems.filter((l) => l.serviceId).map((l) => ({ serviceId: l.serviceId!, supplierName: l.supplierName, supplierCost: l.supplierCost, markupType: l.markupType, markupValue: l.markupValue, supplierVatClaimable: l.supplierVatClaimable, used: false }));
    await tx.orderLineItem.deleteMany({ where: { orderId } });
    for (const li of d.lineItems) {
      const keep = !costs && li.serviceId ? oldCosts.find((c) => c.serviceId === li.serviceId && !c.used) : undefined;
      if (keep) keep.used = true;
      await tx.orderLineItem.create({
        data: {
          orderId,
          itemType: li.itemType,
          serviceId: li.serviceId ?? null,
          materialId: li.materialId ?? null,
          qty: li.qty,
          unitPrice: li.unitPrice,
          discountPct: li.discountPct,
          discountAmt: li.discountAmt,
          heatPressFee: li.heatPressFee ?? null,
          artworkAreaSqm: li.artworkAreaSqm ?? null,
          description: li.description ?? '',
          ...(keep ? { supplierName: keep.supplierName, supplierCost: keep.supplierCost, markupType: keep.markupType, markupValue: keep.markupValue, supplierVatClaimable: keep.supplierVatClaimable } : costFieldsFor(li, costs)),
        },
      });
    }
    const balance = totals.grandTotal - paid;
    // a paid-in-full order that now owes money becomes an invoice, like any order left with a balance
    const settle = order.kind === 'walkin' && order.status === 'Order' && balance > 0.005 ? resolveWalkinStatus(balance) : null;
    await tx.order.update({
      where: { id: orderId },
      data: {
        orderDiscountPct: d.orderDiscountPct,
        orderDiscountAmt: d.orderDiscountAmt,
        ...(order.kind === 'walkin' && d.customerName !== undefined ? { customerName: d.customerName || order.customerName } : {}),
        ...(order.kind === 'walkin' && d.phone !== undefined ? { phone: d.phone || null } : {}),
        ...(settle ? { status: settle.status, dueDate: settle.dueDate } : {}),
      },
    });
    await takeOrderStock(tx, orderId);
    const after = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    await tx.orderChange.update({ where: { id: request.id }, data: { status: 'Done', doneAt: new Date(), beforeJson: before, afterJson: snapshot(after) } });
    return after;
  });
  res.json(serializeDetail(updated));
});

// ── Deleting ─────────────────────────────────────────────────────────────────────────────────────────
orderChangesRouter.delete('/orders/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const request = await approvedFor(req.user!.id, orderId, 'Delete');
  if (!request) return res.status(403).json({ error: 'There is no approved request for you to delete this order. Ask for the deletion first, and wait for it to be approved.' });
  const problem = await deleteProblem(order);
  if (problem) return res.status(400).json({ error: problem });
  if (order.payments.length > 0) {
    return res.status(400).json({ error: `This order has ${order.payments.length} payment${order.payments.length === 1 ? '' : 's'} on it. Move an M-Pesa / NCBA payment to the right order (Accounting → M-Pesa Matching → Matched payments), or refund the customer, before the order is deleted.` });
  }
  const before = snapshot(order);
  try {
    await prisma.$transaction(async (tx) => {
      await returnOrderStock(tx, orderId);
      await tx.mpesaTransaction.updateMany({ where: { orderId }, data: { orderId: null } }); // a push that never completed
      // a film sale or artwork job lives on after its order (the link is only cleared): remove it with the order, which gives its film back to the roll
      await tx.priceApproval.deleteMany({ where: { orderId } });
      await tx.dtfArtworkJob.deleteMany({ where: { orderId } });
      await tx.dtfFilmSale.deleteMany({ where: { orderId } });
      await tx.order.delete({ where: { id: orderId } });
      await tx.orderChange.update({ where: { id: request.id }, data: { status: 'Done', doneAt: new Date(), beforeJson: before, afterJson: '' } });
    });
  } catch (e) {
    console.error('Order delete failed', e);
    return res.status(400).json({ error: 'This order is linked to other records (production, supplier bills or costing) and cannot be deleted. Ask for the amendment instead, or raise a credit note.' });
  }
  res.json({ ok: true, orderNo: order.orderNo, on: todayStr() });
});
