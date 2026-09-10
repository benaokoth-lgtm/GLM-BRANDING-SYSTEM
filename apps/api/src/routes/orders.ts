import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { addDays, buildLineTotal, computeOrderTotals, isOverdue, todayStr } from '@glm/shared';
import type { LineItemInput, PaymentRecord } from '@glm/shared';
import { logFilmUsageForOrder } from './film';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const orderInclude = Prisma.validator<Prisma.OrderInclude>()({
  staff: true,
  corporateClient: true,
  lineItems: { include: { service: true, material: true } },
  payments: { orderBy: { id: 'asc' } },
});

type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function toLineItemInput(li: {
  itemType: string;
  serviceId: number;
  materialId: number | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  filmLengthM?: number | null;
}): LineItemInput {
  return {
    itemType: li.itemType as LineItemInput['itemType'],
    serviceId: li.serviceId,
    materialId: li.materialId,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountAmt: li.discountAmt,
    filmLengthM: li.filmLengthM ?? null,
  };
}

function serializeSummary(order: FullOrder) {
  const lineItems = order.lineItems.map(toLineItemInput);
  const payments: PaymentRecord[] = order.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] }));
  const totals = computeOrderTotals({ lineItems, orderDiscountPct: order.orderDiscountPct, orderDiscountAmt: order.orderDiscountAmt }, payments);
  const overdue = isOverdue(order.kind as 'walkin' | 'corporate', order.status, order.dueDate, totals.balanceDue, todayStr());
  return {
    id: order.id,
    orderNo: order.orderNo,
    kind: order.kind,
    customerName: order.customerName,
    phone: order.phone,
    corporateClient: order.corporateClient ? { id: order.corporateClient.id, name: order.corporateClient.name } : null,
    staff: { id: order.staff.id, name: order.staff.name },
    createdDate: order.createdDate,
    status: order.status,
    stage: order.stage,
    dueDate: order.dueDate,
    totals,
    overdue,
  };
}

function serializeDetail(order: FullOrder) {
  const summary = serializeSummary(order);
  return {
    ...summary,
    paymentTiming: order.paymentTiming,
    orderDiscountPct: order.orderDiscountPct,
    orderDiscountAmt: order.orderDiscountAmt,
    lineItems: order.lineItems.map((li) => ({
      id: li.id,
      itemType: li.itemType,
      serviceId: li.serviceId,
      serviceName: li.service.name,
      materialId: li.materialId,
      materialName: li.material?.name ?? null,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      filmLengthM: li.filmLengthM,
      lineTotal: buildLineTotal(toLineItemInput(li)),
    })),
    payments: order.payments.map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method })),
  };
}

function canAccessOrder(userRole: string, userId: number, order: { staffId: number }): boolean {
  if (userRole === 'Staff') return order.staffId === userId;
  return true;
}

// ── List ─────────────────────────────────────────────────────────────────
ordersRouter.get('/', async (req, res) => {
  const { staffId, status } = req.query as { staffId?: string; status?: string };
  const where: Record<string, unknown> = {};

  if (req.user!.role === 'Staff') {
    where.staffId = req.user!.id;
  } else if (staffId && staffId !== 'all') {
    where.staffId = Number(staffId);
  }
  if (status && status !== 'all') where.status = status;

  const orders = await prisma.order.findMany({ where, include: orderInclude, orderBy: { id: 'desc' } });
  res.json(orders.map(serializeSummary));
});

// ── Detail ───────────────────────────────────────────────────────────────
ordersRouter.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrder(req.user!.role, req.user!.id, order)) return res.status(403).json({ error: 'Not permitted' });
  res.json(serializeDetail(order));
});

const lineItemSchema = z.object({
  itemType: z.enum(['material-service', 'service-only', 'per-metre']),
  serviceId: z.number().int(),
  materialId: z.number().int().nullable().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountPct: z.number().min(0).max(100).default(0),
  discountAmt: z.number().min(0).default(0),
  filmLengthM: z.number().positive().nullable().optional(),
});

const walkinSchema = z.object({
  customerName: z.string().min(1),
  phone: z.string().optional(),
  staffId: z.number().int(),
  paymentTiming: z.enum(['onAcceptance', 'onCompletion']),
  paymentAmount: z.number().min(0).optional(),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).optional(),
  lineItems: z.array(lineItemSchema).min(1),
  orderDiscountPct: z.number().min(0).max(100).default(0),
  orderDiscountAmt: z.number().min(0).default(0),
});

// ── Create walk-in order (Staff only — matches the prototype's role-gated tabs) ──
ordersRouter.post('/walkin', requireRole('Staff'), async (req, res) => {
  const parsed = walkinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const form = parsed.data;

  const order = await prisma.$transaction(async (tx) => {
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const orderNo = 'W-' + settings.nextWalkinNo;
    await tx.setting.update({ where: { id: 1 }, data: { nextWalkinNo: settings.nextWalkinNo + 1 } });

    const created = await tx.order.create({
      data: {
        orderNo,
        kind: 'walkin',
        customerName: form.customerName,
        phone: form.phone,
        staffId: form.staffId,
        createdDate: todayStr(),
        status: 'Order',
        stage: 'Order Received',
        paymentTiming: form.paymentTiming,
        orderDiscountPct: form.orderDiscountPct,
        orderDiscountAmt: form.orderDiscountAmt,
        lineItems: { create: form.lineItems.map((li) => ({ ...li, materialId: li.materialId ?? null })) },
        payments:
          form.paymentTiming === 'onAcceptance' && form.paymentAmount && form.paymentAmount > 0
            ? { create: [{ date: todayStr(), amount: form.paymentAmount, method: form.paymentMethod ?? 'Cash', staffId: form.staffId }] }
            : undefined,
      },
      include: orderInclude,
    });

    // Walk-ins go straight into production, so film-tracked lines deplete the
    // active roll immediately (see logFilmUsageForOrder in routes/film.ts).
    await logFilmUsageForOrder(tx, {
      orderId: created.id,
      date: created.createdDate,
      capturedByName: req.user!.name,
      lineItems: form.lineItems.map((li) => ({ serviceId: li.serviceId, filmLengthM: li.filmLengthM, lineTotal: buildLineTotal(li) })),
    });

    return created;
  });

  res.status(201).json(serializeDetail(order));
});

const quoteSchema = z.object({
  corporateClientId: z.number().int(),
  staffId: z.number().int(),
  lineItems: z.array(lineItemSchema).min(1),
  orderDiscountPct: z.number().min(0).max(100).default(0),
  orderDiscountAmt: z.number().min(0).default(0),
});

// ── Create quotation (Staff only) ───────────────────────────────────────
ordersRouter.post('/quote', requireRole('Staff'), async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const form = parsed.data;

  const order = await prisma.$transaction(async (tx) => {
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const orderNo = 'C-' + settings.nextCorpNo;
    await tx.setting.update({ where: { id: 1 }, data: { nextCorpNo: settings.nextCorpNo + 1 } });

    return tx.order.create({
      data: {
        orderNo,
        kind: 'corporate',
        corporateClientId: form.corporateClientId,
        staffId: form.staffId,
        createdDate: todayStr(),
        status: 'Quote',
        stage: 'Order Received',
        orderDiscountPct: form.orderDiscountPct,
        orderDiscountAmt: form.orderDiscountAmt,
        lineItems: { create: form.lineItems.map((li) => ({ ...li, materialId: li.materialId ?? null })) },
      },
      include: orderInclude,
    });
  });

  res.status(201).json(serializeDetail(order));
});

// ── Record a payment ────────────────────────────────────────────────────
const paymentSchema = z.object({ amount: z.number().positive(), method: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']) });

ordersRouter.post('/:id/payments', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrder(req.user!.role, req.user!.id, order)) return res.status(403).json({ error: 'Not permitted' });

  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  await prisma.payment.create({
    data: { orderId: order.id, date: todayStr(), amount: parsed.data.amount, method: parsed.data.method, staffId: req.user!.id },
  });

  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: orderInclude });
  res.json(serializeDetail(updated!));
});

// ── Set production stage ────────────────────────────────────────────────
const STAGE_VALUES = ['Order Received', 'In Production', 'Quality Check', 'Ready for Pickup/Delivery', 'Completed'] as const;
const stageSchema = z.object({ stage: z.enum(STAGE_VALUES) });

ordersRouter.patch('/:id/stage', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrder(req.user!.role, req.user!.id, order)) return res.status(403).json({ error: 'Not permitted' });

  const parsed = stageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const updated = await prisma.order.update({ where: { id: order.id }, data: { stage: parsed.data.stage }, include: orderInclude });
  res.json(serializeDetail(updated));
});

// ── Convert quotation to invoice ────────────────────────────────────────
// This is when corporate production actually starts, so it's also when
// film-tracked lines deplete the active roll — not at quote-drafting time,
// since a quote may never be accepted.
ordersRouter.post('/:id/convert', requireRole('Staff', 'Supervisor', 'Admin'), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { corporateClient: true, lineItems: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canAccessOrder(req.user!.role, req.user!.id, order)) return res.status(403).json({ error: 'Not permitted' });
  if (order.status !== 'Quote') return res.status(400).json({ error: 'Only quotes can be converted' });

  const days = order.corporateClient?.creditDays ?? 30;
  const dueDate = addDays(todayStr(), days);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.order.update({ where: { id: order.id }, data: { status: 'Invoice', dueDate }, include: orderInclude });
    await logFilmUsageForOrder(tx, {
      orderId: order.id,
      date: todayStr(),
      capturedByName: req.user!.name,
      lineItems: order.lineItems.map((li) => ({ serviceId: li.serviceId, filmLengthM: li.filmLengthM, lineTotal: buildLineTotal(toLineItemInput(li)) })),
    });
    return result;
  });
  res.json(serializeDetail(updated));
});
