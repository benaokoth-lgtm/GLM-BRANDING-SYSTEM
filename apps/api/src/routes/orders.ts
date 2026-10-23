import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { canSeeCosts, costFieldsFor, ensureCostAccessOnce } from '../costs';
import { ensureChartOnce } from '../accounting/chart';
import { claimProblem, resolveSourcing } from '../commission';
import type { CreditLine } from '../commission';
import { takeOrderStock } from '../orderStock';
import { resolveCapture } from '../frontOffice';
import { isSalesPersonOrder, labelFor, salesPersonIds, salesPersonRoleNames } from '../orderSource';
import { WALK_IN_CLIENT } from '@glm/shared';
import { orderHeads, primaryHead } from '../orderHeads';
import { STAGE_DONE, STAGE_READY, logOverride, mayRelease, readyGateOn } from '../orderRelease';
import { DuplicateError, assertNotDuplicate, sendDuplicate } from '../orderDup';
import { buildOrderPdf, documentKind } from '../orderPdf';
import { defaultExpenseVatApplicable } from '@glm/shared';
import { pettyCashShortfall } from '../accounting/ledger';
import { EXPENSE_METHODS, MARKUP_TYPES, PETTY_CASH_METHOD, SETTLED_UNDER, VAT_RATE, addDays, buildLineTotal, computeOrderTotals, isOverdue, jobMargin, needsCosting, round2, todayStr, WALKIN_INVOICE_DUE_DAYS } from '@glm/shared';
import type { LineItemInput, PaymentRecord, PermissionKey } from '@glm/shared';

export const ordersRouter = Router();
ordersRouter.use(requireAuth, async (_req, _res, next) => {
  await ensureCostAccessOnce();
  next();
});

export const orderInclude = Prisma.validator<Prisma.OrderInclude>()({
  staff: true,
  corporateClient: true,
  lineItems: { include: { service: { include: { businessHead: true } }, material: true } },
  payments: { orderBy: { id: 'asc' } },
  dtfArtworkJob: { select: { approvalStatus: true } },
  embroideryJob: { select: { approvalStatus: true } },
  dtfFilmSale: { select: { id: true } },
});

/** An artwork job or an embroidery job priced below the recommended price is on hold until a manager approves it. */
export function priceApprovalPending(o: { dtfArtworkJob?: { approvalStatus: string } | null; embroideryJob?: { approvalStatus: string } | null }): boolean {
  return o.dtfArtworkJob?.approvalStatus === 'Pending' || o.embroideryJob?.approvalStatus === 'Pending';
}

export type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

// What the order LISTS need, and no more: the lists (All Orders) are the heaviest read in the system, and loading the whole staff row, the material and every column of each payment for
// thousands of orders was most of their time. A FullOrder satisfies this shape too, so every summary caller keeps working.
export const orderListInclude = Prisma.validator<Prisma.OrderInclude>()({
  staff: { select: { id: true, name: true } },
  corporateClient: { select: { id: true, name: true, email: true, phone: true, contactPerson: true } },
  lineItems: {
    select: {
      itemType: true,
      serviceId: true,
      materialId: true,
      qty: true,
      unitPrice: true,
      discountPct: true,
      discountAmt: true,
      heatPressFee: true,
      service: { select: { name: true, businessHead: { select: { name: true } } } },
    },
  },
  payments: { select: { date: true, amount: true, method: true }, orderBy: { id: 'asc' } },
  dtfArtworkJob: { select: { approvalStatus: true } },
  embroideryJob: { select: { approvalStatus: true } },
  dtfFilmSale: { select: { id: true } },
});
export type ListOrder = Prisma.OrderGetPayload<{ include: typeof orderListInclude }>;

function toLineItemInput(li: {
  itemType: string;
  serviceId: number | null;
  materialId: number | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  heatPressFee?: number | null;
}): LineItemInput {
  return {
    itemType: li.itemType as LineItemInput['itemType'],
    serviceId: li.serviceId,
    materialId: li.materialId,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountAmt: li.discountAmt,
    heatPressFee: li.heatPressFee ?? null,
  };
}

export function serializeSummary(order: ListOrder) {
  const lineItems = order.lineItems.map(toLineItemInput);
  const payments: PaymentRecord[] = order.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] }));
  const totals = computeOrderTotals({ lineItems, orderDiscountPct: order.orderDiscountPct, orderDiscountAmt: order.orderDiscountAmt }, payments);
  const overdue = isOverdue(order.kind as 'walkin' | 'corporate', order.status, order.dueDate, totals.balanceDue, todayStr());
  return {
    id: order.id,
    orderNo: order.orderNo,
    kind: order.kind,
    channel: order.channel,
    // Whether the order was captured for a sales person ('freelancer') or for GLM ('glm'): the label it was given at capture.
    priceList: order.priceList,
    customerName: order.customerName,
    phone: order.phone,
    corporateClient: order.corporateClient
      ? { id: order.corporateClient.id, name: order.corporateClient.name, email: order.corporateClient.email, phone: order.corporateClient.phone, contactPerson: order.corporateClient.contactPerson }
      : null,
    staff: { id: order.staff.id, name: order.staff.name },
    // Set when someone other than the sales person keyed the order (the front office capturing on their behalf).
    capturedByName: order.capturedByName && order.capturedByName !== order.staff.name ? order.capturedByName : null,
    createdDate: order.createdDate,
    capturedAt: order.capturedAt ? order.capturedAt.toISOString() : null,
    status: order.status,
    stage: order.stage,
    dueDate: order.dueDate,
    totals,
    overdue,
    // An artwork or embroidery job priced below the recommended price is on hold until a manager approves it.
    priceApproval: priceApprovalPending(order) ? ('Pending' as const) : null,
    // Film orders and artwork jobs are both 'dtf' channel orders; this tells them apart.
    dtfKind: order.dtfFilmSale ? ('film' as const) : order.dtfArtworkJob ? ('artwork' as const) : null,
    // The lines of business this order sells (same rule as Sales by Business Head: a service's head, else a name-based default; materials are General Order).
    businessHeads: orderHeads(order.lineItems),
    // The one head the order is counted under in My Orders / All Orders: the head that carries most of its value, so the heads add up to the total.
    businessHead: primaryHead(order.lineItems.map((li) => ({ ...toLineItemInput(li), service: li.service }))),
  };
}

// Cost fields (supplier quote, mark-up) are included only when `costs` is true — i.e. for people who can see costs. The default is to
// withhold them, so every caller that doesn't think about it is safe.
export function serializeDetail(order: FullOrder, opts: { costs?: boolean } = {}) {
  const summary = serializeSummary(order);
  return {
    ...summary,
    paymentTiming: order.paymentTiming,
    salesSource: order.salesSource,
    sourcedByStaffId: order.sourcedByStaffId,
    orderDiscountPct: order.orderDiscountPct,
    orderDiscountAmt: order.orderDiscountAmt,
    lineItems: order.lineItems.map((li) => ({
      id: li.id,
      itemType: li.itemType,
      serviceId: li.serviceId,
      // the name as orders and invoices show it: the service, then what this line is for (the embroidery order's design and stitches)
      serviceName: li.service ? (li.description ? `${li.service.name} — ${li.description}` : li.service.name) : null,
      materialId: li.materialId,
      materialName: li.material?.name ?? null,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      heatPressFee: li.heatPressFee,
      artworkAreaSqm: li.artworkAreaSqm,
      outsourced: !!li.service?.outsourced,
      needsCosting: needsCosting({ outsourced: !!li.service?.outsourced, supplierCost: li.supplierCost }),
      ...(opts.costs ? { supplierName: li.supplierName, supplierCost: li.supplierCost, markupType: li.markupType, markupValue: li.markupValue } : {}),
      lineTotal: buildLineTotal(toLineItemInput(li)),
    })),
    payments: order.payments.map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method, reference: p.reference })),
  };
}

// Everyone sees the orders they captured themselves. Seeing everybody's orders takes the permission to (the Admin always may), or a job that
// works across orders: taking payments, running production, DTF management, quality control, finance and accounting. This follows the person's ROLE
// PERMISSIONS, not the role's name, so a custom role (Sales, Cashier …) is limited the same way the default Staff role is.
const SEES_ALL_ORDERS: PermissionKey[] = ['canViewAllOrders', 'canManagePayments', 'canManageProduction', 'canManageDtf', 'canAccessQuality', 'canAccessFinance', 'canAccessAccounting'];

async function seesAllOrders(user: { role: string }): Promise<boolean> {
  if (user.role === 'Admin') return true;
  const role = await prisma.role.findUnique({ where: { name: user.role } });
  return !!role && SEES_ALL_ORDERS.some((k) => role[k]);
}

export async function canAccessOrder(user: { id: number; role: string }, order: { staffId: number }): Promise<boolean> {
  return order.staffId === user.id || (await seesAllOrders(user));
}

// Money against an order is taken by someone whose job is payments, or by the person who captured the order (the cashier at the till).
export async function canTakePayment(user: { id: number; role: string }, order: { staffId: number }): Promise<boolean> {
  if (user.role === 'Admin') return true;
  const role = await prisma.role.findUnique({ where: { name: user.role } });
  if (!role) return false;
  return role.canManagePayments || (role.canCaptureOrders && order.staffId === user.id);
}

// A walk-in/DTF-channel order settles into one of two documents at capture,
// same rule wherever it's created (New Walk-in Order, DTF Film Sale/Artwork
// Job): paid in full right there -> a closed 'Order' the receipt prints
// against; left with any balance -> 'Invoice' with a due date (there's no
// corporate creditDays to borrow one from here), so it shows up in Accounts
// Receivable and can be aged like any other unpaid invoice.
export function resolveWalkinStatus(balanceDue: number): { status: string; dueDate: string | null } {
  if (balanceDue > 0) return { status: 'Invoice', dueDate: addDays(todayStr(), WALKIN_INVOICE_DUE_DAYS) };
  return { status: 'Order', dueDate: null };
}

// Shared by the explicit "Convert quotation to invoice" action and by
// receiving a deposit payment against a quote (see POST /:id/payments) —
// either is the moment a client has actually accepted the quote and
// production starts.
async function convertQuoteToInvoice(
  tx: Prisma.TransactionClient,
  order: { id: number; corporateClient: { creditDays: number } | null },
) {
  const days = order.corporateClient?.creditDays ?? 30;
  const dueDate = addDays(todayStr(), days);
  await tx.order.update({ where: { id: order.id }, data: { status: 'Invoice', dueDate } });
  await takeOrderStock(tx, order.id); // the client has accepted: the stock leaves the shelf now
}

// ── Payments ──────────────────────────────────────────────────────────────
// One line of a (possibly split) payment: an order can be settled with any mix of methods — say KES 2,000 cash and
// KES 3,000 M-Pesa — each recorded as its own Payment so every method reconciles to its own account.
export const paymentLineSchema = z.object({
  method: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']),
  amount: z.number().positive(),
  // M-Pesa receipt code (or bank/card slip number). Entering an M-Pesa code that is already on a received-but-unmatched
  // statement line ties the two together.
  reference: z.string().trim().max(60).optional().nullable(),
});
export type PaymentLine = z.infer<typeof paymentLineSchema>;
/** Internal: a line already tied to an M-Pesa transaction (an STK push that just succeeded) — no receipt lookup needed. */
export type LinkedPaymentLine = PaymentLine & { linkedTransactionId?: number };

/** What is still free on a received M-Pesa / NCBA receipt: what arrived, less what has been applied to orders so far (a receipt can be shared by several orders). */
export async function receiptLeft(db: Prisma.TransactionClient | typeof prisma, tx: { id: number; amount: number }): Promise<number> {
  const used = await db.payment.aggregate({ _sum: { amount: true }, where: { mpesaTransactionId: tx.id } });
  return Math.max(0, Math.round((tx.amount - (used._sum.amount ?? 0)) * 100) / 100);
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Records one or more payments against an order inside a transaction, and moves the order along: a payment of any
 * size against a quote converts it to an invoice (the client has accepted). An invoice stays an invoice once it is paid in full — it
 * is tracked as one, through production, to completion — so nothing here ever turns it back into an 'Order'. An M-Pesa reference that matches a received statement line
 * (Paybill/Till or an uploaded statement) is linked to it, so the money is matched rather than counted twice.
 */
export async function recordOrderPayments(
  tx: Prisma.TransactionClient,
  order: { id: number; kind: string; status: string; corporateClient: { creditDays: number } | null },
  lines: LinkedPaymentLine[],
  staffId: number | null,
  date: string = todayStr(),
) {
  for (const line of lines) {
    const reference = line.reference ? line.reference.trim().toUpperCase() : null;
    let mpesaTransactionId: number | null = line.linkedTransactionId ?? null;
    let stkClaimed = false;
    let left = 0;
    let receivedTx: { id: number; orderId: number | null } | null = null;
    const linkedByEntry = mpesaTransactionId === null;
    if (linkedByEntry && line.method === 'M-Pesa' && reference) {
      const received = await tx.mpesaTransaction.findUnique({ where: { mpesaReceipt: reference } });
      // An STK push that succeeded before this order existed (walk-in capture) is claimed by the order it paid for.
      const claimable =
        received?.kind === 'STK' && received.status === 'Success' && !received.orderId && !(await tx.payment.findFirst({ where: { mpesaTransactionId: received.id } }));
      if (received && claimable) {
        await tx.mpesaTransaction.update({ where: { id: received.id }, data: { orderId: order.id } });
        mpesaTransactionId = received.id;
        stkClaimed = true;
      } else if (received) {
        if (received.status !== 'Unmatched') throw new PaymentError(`M-Pesa receipt ${reference} has already been used`);
        // a receipt can be shared by several orders: this payment may be any part of what is still free on it
        left = await receiptLeft(tx, received);
        if (line.amount > left + 1) {
          throw new PaymentError(`M-Pesa receipt ${reference} is for Ksh ${Math.round(received.amount).toLocaleString('en-KE')} and only Ksh ${Math.round(left).toLocaleString('en-KE')} of it is still free (the rest is on other orders), not Ksh ${Math.round(line.amount).toLocaleString('en-KE')}`);
        }
        mpesaTransactionId = received.id;
        receivedTx = received;
      }
    }
    await tx.payment.create({
      data: { orderId: order.id, date, amount: line.amount, method: line.method, reference, mpesaTransactionId, staffId },
    });
    if (mpesaTransactionId && linkedByEntry && !stkClaimed) {
      // fully used up → Applied; part of it still free → it stays on the waiting list with what is left, for the next order
      const used = left - line.amount < 1;
      await tx.mpesaTransaction.update({
        where: { id: mpesaTransactionId },
        data: { orderId: receivedTx?.orderId ?? order.id, appliedByName: used ? 'Matched on entry' : 'Matched on entry (part)', ...(used ? { status: 'Applied', appliedAt: new Date() } : {}) },
      });
    }
  }

  if (order.status === 'Quote') {
    await convertQuoteToInvoice(tx, order);
  }
}

// ── List ─────────────────────────────────────────────────────────────────
ordersRouter.get('/', async (req, res) => {
  const { staffId, status, channel, days, source } = req.query as { staffId?: string; status?: string; channel?: string; days?: string; source?: string };
  const where: Record<string, unknown> = {};
  // days=N (All Orders): the orders raised in the last N days, plus everything still open however old — not yet completed, or handed over on credit with a balance — so the
  // screen's open-order figures stay complete while years of finished orders are left out. Without it the whole list is returned, as before.
  const window = Number(days);
  if (Number.isInteger(window) && window > 0 && window <= 3650) {
    const cutoff = addDays(todayStr(), -window);
    where.OR = [{ createdDate: { gte: cutoff } }, { stage: { not: 'Completed' }, status: { not: 'Quote' } }, { handedOverOnCredit: true }];
  }

  if (!(await seesAllOrders(req.user!))) {
    where.staffId = req.user!.id;
  } else if (staffId && staffId !== 'all') {
    where.staffId = Number(staffId);
  }
  if (status && status !== 'all') where.status = status;
  // 'film' and 'artwork' split the DTF channel; 'general' and 'dtf' (both together) still work.
  if (channel === 'film') {
    where.channel = 'dtf';
    where.dtfFilmSale = { isNot: null };
  } else if (channel === 'artwork') {
    where.channel = 'dtf';
    where.dtfArtworkJob = { isNot: null };
  } else if (channel && channel !== 'all') where.channel = channel;

  // source=glm / sales: GLM's own sales, or the sales persons' — by who the order is credited to (the person it was allocated to, the one whose client it is, or an old freelance account)
  const people = await salesPersonIds();
  const peopleList = [...people];
  if (source === 'sales') where.AND = [{ OR: [{ freelanceAgentId: { not: null } }, { sourcedByStaffId: { in: peopleList } }, { AND: [{ sourcedByStaffId: null }, { staffId: { in: peopleList } }] }] }];
  else if (source === 'glm') where.AND = [{ freelanceAgentId: null }, { OR: [{ sourcedByStaffId: { notIn: peopleList } }, { AND: [{ sourcedByStaffId: null }, { staffId: { notIn: peopleList } }] }] }];
  const orders = await prisma.order.findMany({ where, include: orderListInclude, orderBy: { id: 'desc' } });
  res.json(orders.map((o) => ({ ...serializeSummary(o), source: isSalesPersonOrder(o, people) ? ('sales' as const) : ('glm' as const) })));
});

// ── Detail ───────────────────────────────────────────────────────────────
// The invoice / quotation / receipt as a PDF file — for sharing on WhatsApp or saving. The same document that is attached to emails (see orderPdf.ts).
ordersRouter.get('/:id/pdf', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const detail = serializeDetail(order);
  const company = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const file = `${documentKind(detail).label}-${detail.orderNo}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.pdf';
  const pdf = await buildOrderPdf(detail, company);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Content-Length', String(pdf.length));
  res.send(pdf);
});

ordersRouter.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const sourcer = order.sourcedByStaffId ? await prisma.user.findUnique({ where: { id: order.sourcedByStaffId }, select: { name: true } }) : null;
  const freelancer = order.freelanceAgentId ? await prisma.freelanceAgent.findUnique({ where: { id: order.freelanceAgentId }, select: { name: true } }) : null;
  res.json({ ...serializeDetail(order, { costs: await canSeeCosts(req.user!.role) }), sourcedByName: sourcer?.name ?? null, freelanceAgentName: freelancer?.name ?? null, canTakePayment: await canTakePayment(req.user!, order) });
});

// A line is either a material sale ('material': materialId set, no service)
// or a service fee ('service'/'per-metre': serviceId set, no material) —
// never both, matching the schema.prisma comment on OrderLineItem.
export const lineItemSchema = z
  .object({
    itemType: z.enum(['material', 'service', 'per-metre']),
    serviceId: z.number().int().nullable().optional(),
    materialId: z.number().int().nullable().optional(),
    qty: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    discountPct: z.number().min(0).max(100).default(0),
    discountAmt: z.number().min(0).default(0),
    heatPressFee: z.number().nonnegative().nullable().optional(),
    artworkAreaSqm: z.number().positive().nullable().optional(),
    // What the line is for, shown after its name (the embroidery order uses it for "Left chest logo · 6,000 stitches").
    description: z.string().trim().max(160).optional(),
    // Outsourced services: the supplier's quote for this job and the mark-up behind the price. Honoured only for people who can see costs.
    supplierName: z.string().trim().max(120).nullable().optional(),
    supplierCost: z.number().min(0).nullable().optional(),
    markupType: z.enum(MARKUP_TYPES).nullable().optional(),
    markupValue: z.number().min(0).nullable().optional(),
  })
  .refine((li) => (li.itemType === 'material' ? !!li.materialId : !!li.serviceId), {
    message: 'A material line needs a material, a service line needs a service',
  });

export const walkinSchema = z.object({
  // Optional: a walk-in with no name is recorded as "Walk-in". Name and phone are only required to credit a client to a staff member.
  customerName: z.string().optional(),
  phone: z.string().optional(),
  // The sales person the order is credited to. Left out (or null), it is in the capturing person's own name; only the front office may name someone else.
  staffId: z.number().int().nullable().optional(),
  paymentTiming: z.enum(['onAcceptance', 'onCompletion']),
  paymentAmount: z.number().min(0).optional(),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).optional(),
  // Set to your own id when this is a client you sourced through your own network: they are then credited to you for 12 months.
  sourcedBy: z.number().int().nullable().optional(),
  // Brought by a freelance sales person (their account is credited, weekly): then no staff member is credited — never both.
  freelanceAgentId: z.number().int().nullable().optional(),
  // Preferred: any number of payment lines, e.g. part cash and part M-Pesa.
  payments: z.array(paymentLineSchema).max(6).optional(),
  lineItems: z.array(lineItemSchema).min(1),
  orderDiscountPct: z.number().min(0).max(100).default(0),
  orderDiscountAmt: z.number().min(0).default(0),
});

// ── Create walk-in order (canCaptureOrders — Staff by default) ───────────
ordersRouter.post('/walkin', requirePermission('canCaptureOrders'), async (req, res) => {
  const parsed = walkinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  return captureWalkin(req, res, parsed.data);
});

export type WalkinForm = z.infer<typeof walkinSchema>;

/** How the embroidery order (routes/embroidery.ts) differs from a General Order: its own numbering, the base price each line is measured against for commission, and a hook run inside the same transaction. */
export interface WalkinExtras {
  /** Keep the supplier cost typed on the lines even when the person capturing may not see costs (a costed job: the cost is the costing's, not theirs to enter). */
  keepCosts?: boolean;
  prefix?: string;
  counter?: 'nextWalkinNo' | 'nextEmbroideryNo';
  creditLines?: CreditLine[];
  after?: (tx: Prisma.TransactionClient, order: { id: number; orderNo: string }) => Promise<void>;
}

/** Captures a walk-in order from a checked form: the sales person and cashier, payments, status, sourcing, numbering and the receipt-ready result. */
export async function captureWalkin(req: import('express').Request, res: import('express').Response, form: WalkinForm, extra: WalkinExtras = {}) {
  // Who the order is credited to (the sales person) and who keys it (the cashier): decided here, from the person's role and whether their order taking is on.
  const cap = await resolveCapture(req.user!, form.staffId, form.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const label = await labelFor(cap.staffId);
  const costs = extra.keepCosts ? true : await canSeeCosts(req.user!.role);

  // Payments taken at capture: the new list form, or the older single amount + method.
  const paymentLines: PaymentLine[] =
    form.paymentTiming !== 'onAcceptance'
      ? []
      : form.payments && form.payments.length
        ? form.payments
        : (form.paymentAmount ?? 0) > 0
          ? [{ method: form.paymentMethod ?? 'Cash', amount: form.paymentAmount! }]
          : [];
  const totals = computeOrderTotals(
    { lineItems: form.lineItems, orderDiscountPct: form.orderDiscountPct, orderDiscountAmt: form.orderDiscountAmt },
    paymentLines.map((p) => ({ date: todayStr(), amount: p.amount, method: p.method })),
  );
  if (paymentLines.reduce((a, p) => a + p.amount, 0) > totals.grandTotal + 0.01) {
    return res.status(400).json({ error: 'The payments add up to more than the order total' });
  }
  const { status, dueDate } = resolveWalkinStatus(totals.balanceDue);
  const claim = await claimProblem(req.user!, { phone: form.phone, name: form.customerName, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  try {
    await assertNotDuplicate(prisma, { phone: form.phone, name: form.customerName, total: totals.grandTotal }, !!req.body?.confirmDuplicate);
  } catch (e) {
    if (e instanceof DuplicateError) return sendDuplicate(res, e);
    throw e;
  }

  const order = await prisma.$transaction(async (tx) => {
    const sourcing = await resolveSourcing(tx, { phone: form.phone, name: form.customerName, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId, lines: extra.creditLines ?? form.lineItems, orderDiscountPct: form.orderDiscountPct, orderDiscountAmt: form.orderDiscountAmt });
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const counter = extra.counter ?? 'nextWalkinNo';
    const orderNo = (extra.prefix ?? 'W-') + settings[counter];
    await tx.setting.update({ where: { id: 1 }, data: { [counter]: settings[counter] + 1 } });

    const created = await tx.order.create({
      data: {
        orderNo,
        kind: 'walkin',
        priceList: label,
        customerName: form.customerName?.trim() || WALK_IN_CLIENT,
        phone: form.phone?.trim() || null,
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        ...sourcing,
        createdDate: todayStr(),
        capturedAt: new Date(),
        status,
        dueDate,
        stage: 'Order Received',
        paymentTiming: form.paymentTiming,
        orderDiscountPct: form.orderDiscountPct,
        orderDiscountAmt: form.orderDiscountAmt,
        lineItems: { create: form.lineItems.map((li) => ({ ...li, serviceId: li.serviceId ?? null, materialId: li.materialId ?? null, ...costFieldsFor(li, costs) })) },
      },
      include: orderInclude,
    });
    await takeOrderStock(tx, created.id);
    await extra.after?.(tx, created);
    if (paymentLines.length || extra.after) {
      if (paymentLines.length) await recordOrderPayments(tx, { id: created.id, kind: 'walkin', status, corporateClient: null }, paymentLines, cap.capturedById); // the money is the cashier's
      return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: orderInclude });
    }
    return created;
  });

  res.status(201).json(serializeDetail(order));
}

const quoteSchema = z.object({
  corporateClientId: z.number().int(),
  staffId: z.number().int(),
  // The staff member who sourced this corporate client, if it is new to them (credited for 12 months).
  sourcedBy: z.number().int().nullable().optional(),
  // Or brought by a freelance sales person — then no staff member is credited.
  freelanceAgentId: z.number().int().nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1),
  orderDiscountPct: z.number().min(0).max(100).default(0),
  orderDiscountAmt: z.number().min(0).default(0),
});

// ── Create quotation — now a Finance-tab action (New Quotation moved into
// Finance alongside Invoice, All Orders, Payments and P&L), not a Staff
// self-service one ──────────────────────────────────────────────────────
ordersRouter.post('/quote', requirePermission('canAccessFinance'), async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const form = parsed.data;
  const costs = await canSeeCosts(req.user!.role);
  const claim = await claimProblem(req.user!, { corporateClientId: form.corporateClientId, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });

  const order = await prisma.$transaction(async (tx) => {
    const sourcing = await resolveSourcing(tx, { corporateClientId: form.corporateClientId, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId, lines: form.lineItems, orderDiscountPct: form.orderDiscountPct, orderDiscountAmt: form.orderDiscountAmt });
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const orderNo = 'C-' + settings.nextCorpNo;
    await tx.setting.update({ where: { id: 1 }, data: { nextCorpNo: settings.nextCorpNo + 1 } });

    return tx.order.create({
      data: {
        orderNo,
        kind: 'corporate',
        corporateClientId: form.corporateClientId,
        staffId: form.staffId,
        ...sourcing,
        createdDate: todayStr(),
        capturedAt: new Date(),
        status: 'Quote',
        stage: 'Order Received',
        orderDiscountPct: form.orderDiscountPct,
        orderDiscountAmt: form.orderDiscountAmt,
        lineItems: { create: form.lineItems.map((li) => ({ ...li, serviceId: li.serviceId ?? null, materialId: li.materialId ?? null, ...costFieldsFor(li, costs) })) },
      },
      include: orderInclude,
    });
  });

  res.status(201).json(serializeDetail(order));
});

// ── Create invoice directly — for a client who's already negotiated and
// agreed, with no quotation step needed first. Same shape as a quote, but
// skips straight to 'Invoice' (due date set from the client's credit terms)
// — exactly the end state convertQuoteToInvoice would leave a quote in,
// just without ever having been a quote.
ordersRouter.post('/invoice', requirePermission('canAccessFinance'), async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const form = parsed.data;
  const costs = await canSeeCosts(req.user!.role);

  const client = await prisma.corporateClient.findUnique({ where: { id: form.corporateClientId } });
  if (!client) return res.status(400).json({ error: 'Corporate client not found' });
  const dueDate = addDays(todayStr(), client.creditDays);
  const claim = await claimProblem(req.user!, { corporateClientId: form.corporateClientId, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  try {
    const t = computeOrderTotals({ lineItems: form.lineItems, orderDiscountPct: form.orderDiscountPct, orderDiscountAmt: form.orderDiscountAmt }, []);
    await assertNotDuplicate(prisma, { corporateClientId: form.corporateClientId, total: t.grandTotal }, !!req.body?.confirmDuplicate);
  } catch (e) {
    if (e instanceof DuplicateError) return sendDuplicate(res, e);
    throw e;
  }

  const order = await prisma.$transaction(async (tx) => {
    const sourcing = await resolveSourcing(tx, { corporateClientId: form.corporateClientId, sourcedBy: form.sourcedBy, freelanceAgentId: form.freelanceAgentId, lines: form.lineItems, orderDiscountPct: form.orderDiscountPct, orderDiscountAmt: form.orderDiscountAmt });
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const orderNo = 'C-' + settings.nextCorpNo;
    await tx.setting.update({ where: { id: 1 }, data: { nextCorpNo: settings.nextCorpNo + 1 } });

    const created = await tx.order.create({
      data: {
        orderNo,
        kind: 'corporate',
        corporateClientId: form.corporateClientId,
        staffId: form.staffId,
        ...sourcing,
        createdDate: todayStr(),
        capturedAt: new Date(),
        status: 'Invoice',
        stage: 'Order Received',
        dueDate,
        orderDiscountPct: form.orderDiscountPct,
        orderDiscountAmt: form.orderDiscountAmt,
        lineItems: { create: form.lineItems.map((li) => ({ ...li, serviceId: li.serviceId ?? null, materialId: li.materialId ?? null, ...costFieldsFor(li, costs) })) },
      },
      include: orderInclude,
    });
    await takeOrderStock(tx, created.id);

    return created;
  });

  res.status(201).json(serializeDetail(order));
});

// ── Record a payment (one method, or several — "split" — in one go) ──────
const paymentSchema = z
  .object({
    amount: z.number().positive().optional(),
    method: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).optional(),
    reference: z.string().trim().max(60).optional().nullable(),
    payments: z.array(paymentLineSchema).min(1).max(6).optional(),
    // A manager's reason for settling the order before it is ready (see orderRelease.ts).
    overrideReason: z.string().trim().max(300).optional(),
  })
  .refine((b) => (b.payments && b.payments.length > 0) || (b.amount && b.method), { message: 'Enter at least one payment' });

ordersRouter.post('/:id/payments', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { corporateClient: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });

  if (!(await canTakePayment(req.user!, order))) return res.status(403).json({ error: 'Payments on this order are taken by the person who captured it or by someone who handles payments' });

  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const lines: PaymentLine[] = parsed.data.payments?.length
    ? parsed.data.payments
    : [{ method: parsed.data.method!, amount: parsed.data.amount!, reference: parsed.data.reference ?? null }];

  const current = await prisma.order.findUnique({ where: { id: order.id }, include: orderInclude });
  if (current && priceApprovalPending(current)) {
    return res.status(400).json({ error: 'This job is priced below the recommended price and is waiting for a manager’s approval — payment is taken once it is approved' });
  }
  const before = serializeSummary(current!).totals;
  const paying = lines.reduce((a, p) => a + p.amount, 0);
  if (paying > before.balanceDue + 0.01) {
    return res.status(400).json({ error: `The payments add up to Ksh ${Math.round(paying).toLocaleString('en-KE')}, but only Ksh ${Math.round(before.balanceDue).toLocaleString('en-KE')} is outstanding` });
  }

  // The payment that SETTLES the order is taken at the counter, with the handover, once the order is ready; a deposit or part-payment can be taken at any stage. (Money that arrives by itself — an
  // M-Pesa push, a Paybill payment matched to the order — is recorded whenever it comes: it is money in, and Day close lists orders paid but not produced.)
  let overrideReason: string | null = null;
  const settles = before.balanceDue > 0.005 && before.balanceDue - paying < SETTLED_UNDER; // what is left is under Ksh 1: the order is settled
  if (settles && current!.stage !== STAGE_DONE && (await readyGateOn())) {
    const ready = current!.stage === STAGE_READY;
    const may = await mayRelease(req.user!);
    const reason = (parsed.data.overrideReason ?? '').trim();
    if (!(may && reason)) {
      return res.status(409).json({
        code: ready ? 'USE_COUNTER' : 'FINAL_PAYMENT_NOT_READY',
        canOverride: may,
        error: ready
          ? 'This payment settles the order. Take it with “Take final payment & hand over”, so the order leaves through the counter.'
          : `This payment would settle the order, but it is at “${current!.stage}” — it has not been produced and passed quality control. The final payment is taken when the order is ready, together with the handover. A deposit or part-payment can be taken now.${may ? ' As a manager you can take it now with a reason.' : ' A manager can release it with a reason.'}`,
      });
    }
    overrideReason = reason;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await recordOrderPayments(tx, order, lines, req.user!.id);
      if (overrideReason) await logOverride(tx, { orderId: order.id, orderNo: order.orderNo, kind: 'FinalPayment', stage: current!.stage, amount: paying, reason: overrideReason, byName: req.user!.name });
    });
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }

  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: orderInclude });
  res.json(serializeDetail(updated!));
});

// ── Outsourced jobs: costing, supplier bills, profit ─────────────────────────
// Everything here is for people who can see costs. A contracted-out service has ONE supplier price (paper and service together,
// VAT included) which we mark up. The quote is captured per job on the order line; the supplier's bill — and any deposit paid with
// it — is an expense tied to the order, and that is the job's cost of sales.
async function requireCosts(req: { user?: { role: string } }, res: import('express').Response): Promise<boolean> {
  if (await canSeeCosts(req.user!.role)) return true;
  res.status(403).json({ error: 'Not permitted for your role' });
  return false;
}

const BILL_CATEGORY = 'Outsourced Services';

async function jobCosting(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { ...orderInclude, expenses: { where: { category: BILL_CATEGORY }, include: { payments: true }, orderBy: { id: 'asc' } } },
  });
  if (!order) return null;
  const supplierVatClaimed = (await prisma.expenseHead.findUnique({ where: { name: BILL_CATEGORY } }))?.vatApplicable ?? defaultExpenseVatApplicable(BILL_CATEGORY);
  const inputs = order.lineItems.map(toLineItemInput);
  const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
  const totals = computeOrderTotals({ lineItems: inputs, orderDiscountPct: order.orderDiscountPct, orderDiscountAmt: order.orderDiscountAmt });
  // What the order-level discount leaves of each line, so an outsourced line's sale is what the customer really pays for it.
  const scale = subtotal > 0 ? totals.grandTotal / subtotal : 0;
  const lines = order.lineItems
    .map((li, i) => ({ li, sale: round2(buildLineTotal(inputs[i]!) * scale) }))
    .filter(({ li }) => li.service?.outsourced)
    .map(({ li, sale }) => ({
      lineId: li.id,
      service: li.service!.name,
      qty: li.qty,
      unitPrice: li.unitPrice,
      sale,
      supplierName: li.supplierName ?? li.service!.supplierName ?? '',
      supplierCost: li.supplierCost,
      markupType: li.markupType,
      markupValue: li.markupValue,
      estimatedCost: li.supplierCost != null ? round2(li.supplierCost * li.qty) : null,
      needsCosting: needsCosting({ outsourced: true, supplierCost: li.supplierCost }),
    }));
  const bills = order.expenses.map((e) => {
    const paid = e.paid ? e.amount : round2(e.payments.reduce((a, p) => a + p.amount, 0));
    return { id: e.id, date: e.date, supplier: e.supplier, invoiceNumber: e.invoiceNumber, note: e.note, amount: e.amount, paid, owing: round2(e.amount - paid), dueDate: e.dueDate };
  });
  const sale = round2(lines.reduce((a, l) => a + l.sale, 0));
  const estimated = round2(lines.reduce((a, l) => a + (l.estimatedCost ?? 0), 0));
  const billed = round2(bills.reduce((a, b) => a + b.amount, 0));
  const paid = round2(bills.reduce((a, b) => a + b.paid, 0));
  // The real cost is what the supplier billed; until a bill is in, the quote stands in for it.
  const cost = billed > 0 ? billed : estimated;
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    lines,
    bills,
    sale,
    estimatedCost: estimated,
    billed,
    paid,
    owing: round2(billed - paid),
    costBasis: billed > 0 ? 'supplier bills' : estimated > 0 ? 'quote (no bill recorded yet)' : 'not costed',
    // The supplier's VAT is claimed back as input VAT when the Outsourced Services head carries VAT (the standing treatment).
    margin: jobMargin(sale, cost, VAT_RATE, supplierVatClaimed),
    unbilledQuote: billed > 0 ? round2(Math.max(0, estimated - billed)) : estimated,
  };
}

ordersRouter.get('/outsourced/jobs', async (req, res) => {
  if (!(await requireCosts(req, res))) return;
  const orders = await prisma.order.findMany({
    where: { lineItems: { some: { service: { outsourced: true } } }, OR: [{ kind: 'walkin' }, { status: { not: 'Quote' } }] },
    select: { id: true },
    orderBy: { id: 'desc' },
    take: 300,
  });
  const jobs = (await Promise.all(orders.map((o) => jobCosting(o.id)))).filter((j): j is NonNullable<typeof j> => !!j);
  const full = await prisma.order.findMany({ where: { id: { in: jobs.map((j) => j.orderId) } }, include: { corporateClient: true } });
  const byId = new Map(full.map((o) => [o.id, o]));
  res.json({
    jobs: jobs.map((j) => {
      const o = byId.get(j.orderId)!;
      return { ...j, customer: o.customerName || o.corporateClient?.name || 'Customer', date: o.createdDate, stage: o.stage, status: o.status, suppliers: [...new Set(j.lines.map((l) => l.supplierName).filter(Boolean))] };
    }),
    totals: {
      sale: round2(jobs.reduce((a, j) => a + j.sale, 0)),
      billed: round2(jobs.reduce((a, j) => a + j.billed, 0)),
      owing: round2(jobs.reduce((a, j) => a + j.owing, 0)),
      needCosting: jobs.filter((j) => j.lines.some((l) => l.needsCosting)).length,
    },
  });
});

ordersRouter.get('/:id/costing', async (req, res) => {
  if (!(await requireCosts(req, res))) return;
  const costing = await jobCosting(Number(req.params.id));
  if (!costing) return res.status(404).json({ error: 'Order not found' });
  res.json(costing);
});

// Record (or correct) the supplier's quote and the mark-up on the order's outsourced lines. This does not change the selling price.
const costingSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.number().int(),
        supplierCost: z.number().min(0).nullable(),
        markupType: z.enum(MARKUP_TYPES).nullable().optional(),
        markupValue: z.number().min(0).nullable().optional(),
        supplierName: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .min(1),
});

ordersRouter.put('/:id/costing', async (req, res) => {
  if (!(await requireCosts(req, res))) return;
  const parsed = costingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { lineItems: { include: { service: true } } } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  for (const l of parsed.data.lines) {
    const line = order.lineItems.find((x) => x.id === l.lineId);
    if (!line || !line.service?.outsourced) return res.status(400).json({ error: 'That line is not an outsourced service on this order' });
  }
  await prisma.$transaction(
    parsed.data.lines.map((l) =>
      prisma.orderLineItem.update({
        where: { id: l.lineId },
        data: { supplierCost: l.supplierCost, markupType: l.supplierCost == null ? null : l.markupType ?? 'percent', markupValue: l.supplierCost == null ? null : l.markupValue ?? 0, supplierName: l.supplierName || null },
      }),
    ),
  );
  res.json(await jobCosting(order.id));
});

// Record a supplier's bill for the job. Suppliers are paid upfront or with a deposit, so a bill can be paid in full now, part now
// (a deposit — the balance stays owing in Accounts Payable until it is paid under Finance → Expenses), or not at all yet.
const supplierBillSchema = z.object({
  supplierName: z.string().trim().min(1, 'Who is the supplier?').max(120),
  amount: z.number().positive('Enter the amount the supplier is charging (VAT included)'),
  paidNow: z.number().min(0).default(0),
  method: z.enum(EXPENSE_METHODS).default('Bank Transfer'),
  invoiceNumber: z.string().trim().max(100).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  note: z.string().max(200).optional(),
});

ordersRouter.post('/:id/supplier-bills', async (req, res) => {
  if (!(await requireCosts(req, res))) return;
  const parsed = supplierBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { lineItems: { include: { service: true } } } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.lineItems.some((l) => l.service?.outsourced)) return res.status(400).json({ error: 'This order has no outsourced service on it' });
  if (d.paidNow > d.amount + 0.005) return res.status(400).json({ error: 'The amount paid now is more than the bill' });

  // Paying from petty cash needs the float to cover it.
  if (d.paidNow > 0 && d.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(d.paidNow, todayStr());
    if (check.short) return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available, Ksh ${Math.round(d.paidNow).toLocaleString('en-KE')} needed)` });
  }

  await ensureChartOnce();
  const today = todayStr();
  const fullyPaid = d.paidNow >= d.amount - 0.005;
  const expense = await prisma.expense.create({
    data: {
      date: today,
      category: BILL_CATEGORY,
      amount: d.amount,
      supplier: d.supplierName,
      invoiceNumber: d.invoiceNumber || null,
      note: d.note ? d.note : `${order.orderNo} — outsourced job${d.paidNow > 0 && !fullyPaid ? ' (deposit paid, balance owing)' : ''}`,
      orderId: order.id,
      // The supplier's bill is a cost of the line of business the contracted-out service belongs to.
      businessHeadId: order.lineItems.find((l) => l.service?.outsourced)?.service?.businessHeadId ?? null,
      capturedByName: req.user!.name,
      // Paid in full: a plain paid expense. Otherwise it is a bill on credit, with the deposit (if any) recorded as a payment against it.
      paid: fullyPaid,
      method: fullyPaid ? d.method : PETTY_CASH_METHOD,
      dueDate: fullyPaid ? null : d.dueDate ?? null,
    },
  });
  if (!fullyPaid && d.paidNow > 0) {
    await prisma.expensePayment.create({ data: { expenseId: expense.id, date: today, amount: d.paidNow, method: d.method, note: 'Deposit', capturedByName: req.user!.name } });
  }
  res.status(201).json(await jobCosting(order.id));
});

// ── Hand an order over to the customer — the ONLY way an order becomes Completed ──
// The production stage is no longer set by hand. It moves only through Production (assign → in production → finish) and
// Quality Control (pass → ready, fail → back to production). Neither can declare an order completed: completing it is the
// customer collecting / receiving it, and only an order that has passed QC ("Ready for Pickup/Delivery") can be handed over.
//
// Handover also needs the order PAID IN FULL — unless the person handing it over chooses to release it on credit
// ({ onCredit: true }). Then the order is converted to an invoice automatically: status 'Invoice' with a due date (the client's
// credit terms, or WALKIN_INVOICE_DUE_DAYS for a walk-in), so what is still owed is collected and aged in Accounts Receivable.
const handoverSchema = z.object({
  onCredit: z.boolean().optional(),
  // The final payment, taken in the same action: "Take final payment & hand over". Recorded and the handover done together, or neither.
  payments: z.array(paymentLineSchema).min(1).max(6).optional(),
  // A manager handing over before the order is ready (not produced, or not through quality control), with the reason.
  overrideReason: z.string().trim().max(300).optional(),
});

ordersRouter.post('/:id/handover', async (req, res) => {
  const parsed = handoverSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
  const onCredit = parsed.data.onCredit === true;
  const payLines = parsed.data.payments ?? [];

  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  if (order.stage === STAGE_DONE) return res.status(400).json({ error: 'This order has already been handed over' });
  if (order.status === 'Quote') return res.status(400).json({ error: 'This is a quotation: it has to be accepted and produced before it can be handed over' });
  let override: string | null = null;
  if (order.stage !== STAGE_READY) {
    const reason = (parsed.data.overrideReason ?? '').trim();
    if (!reason || !(await mayRelease(req.user!))) {
      return res.status(400).json({
        code: 'NOT_READY',
        canOverride: await mayRelease(req.user!),
        error: `This order is at “${order.stage}”. It can only be handed over once it has been produced and has passed quality control.${(await mayRelease(req.user!)) ? ' As a manager you can release it now with a reason.' : ' A manager can release it with a reason.'}`,
      });
    }
    override = reason;
  }
  if (priceApprovalPending(order)) return res.status(400).json({ error: 'This job is priced below the recommended price and is waiting for a manager’s approval' });

  const balance = serializeDetail(order).totals.balanceDue;
  const paying = payLines.reduce((a, p) => a + p.amount, 0);
  if (payLines.length && !(await canTakePayment(req.user!, order))) return res.status(403).json({ error: 'Payments on this order are taken by the person who captured it or by someone who handles payments' });
  if (paying > balance + 0.01) {
    return res.status(400).json({ error: `The payments add up to Ksh ${Math.round(paying).toLocaleString('en-KE')}, but only Ksh ${Math.round(balance).toLocaleString('en-KE')} is outstanding` });
  }
  const owes = balance - paying >= SETTLED_UNDER; // under Ksh 1 left counts as paid
  if (owes && !onCredit) {
    return res.status(400).json({
      error: `This order still owes Ksh ${Math.round(balance - paying).toLocaleString('en-KE')}. Take the whole payment, or hand it over on credit, which turns it into an invoice.`,
      balanceDue: balance - paying,
      code: 'BALANCE_DUE',
    });
  }

  const data: Prisma.OrderUpdateInput = { stage: STAGE_DONE, handedOverAt: new Date(), handedOverByName: req.user!.name, handedOverOnCredit: owes };
  if (owes) {
    // Converted to an invoice now. An invoice that already has a due date still in the future keeps it; otherwise the due date
    // is counted from today on the client's credit terms (or the walk-in term).
    const days = order.corporateClient?.creditDays ?? WALKIN_INVOICE_DUE_DAYS;
    data.status = 'Invoice';
    if (!order.dueDate || order.dueDate < todayStr()) data.dueDate = addDays(todayStr(), days);
  }
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      if (payLines.length) await recordOrderPayments(tx, order, payLines, req.user!.id);
      if (override) await logOverride(tx, { orderId: order.id, orderNo: order.orderNo, kind: 'Handover', stage: order.stage, amount: paying, reason: override, byName: req.user!.name });
      return tx.order.update({ where: { id: order.id }, data, include: orderInclude });
    });
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }
  res.json({ ...serializeDetail(updated), handedOverOnCredit: owes });
});

// ── Convert quotation to invoice ────────────────────────────────────────
// This is when corporate production actually starts — not at
// quote-drafting time, since a quote may never be accepted.
ordersRouter.post('/:id/convert', requirePermission('canCaptureOrders', 'canViewAllOrders'), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { corporateClient: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  if (order.status !== 'Quote') return res.status(400).json({ error: 'Only quotes can be converted' });

  await prisma.$transaction((tx) => convertQuoteToInvoice(tx, order));
  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: orderInclude });
  res.json(serializeDetail(updated!));
});
