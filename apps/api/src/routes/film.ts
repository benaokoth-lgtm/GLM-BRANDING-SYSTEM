import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { DTF_PRINT_QUEUE_BATCH_SQM, todayStr } from '@glm/shared';
import { computePettyCashBalance } from './finance';

export const filmRouter = Router();
filmRouter.use(requireAuth, requirePermission('canAccessFilm'));

// ── Shared aggregation helpers ──────────────────────────────────────────
function weightedAvgRate(usages: { lengthM: number; ratePerMeter: number | null }[]): number | null {
  let lenSum = 0;
  let revSum = 0;
  for (const u of usages) {
    if (u.ratePerMeter == null) continue;
    lenSum += u.lengthM;
    revSum += u.lengthM * u.ratePerMeter;
  }
  return lenSum > 0 ? revSum / lenSum : null;
}

function serializeRoll(roll: Prisma.FilmRollGetPayload<{ include: { usages: true } }>) {
  const usedM = roll.usages.reduce((a, u) => a + u.lengthM, 0);
  const remainingM = roll.status === 'Active' ? Math.max(0, roll.lengthM - usedM) : 0;
  const costPerMeter = roll.lengthM > 0 ? roll.costTotal / roll.lengthM : 0;
  const avgRatePerMeter = roll.status === 'Finished' ? roll.avgRatePerMeter : weightedAvgRate(roll.usages);
  const marginPerMeter = avgRatePerMeter != null ? avgRatePerMeter - costPerMeter : null;
  return {
    id: roll.id,
    lengthM: roll.lengthM,
    costTotal: roll.costTotal,
    invoiceNumber: roll.invoiceNumber,
    costPerMeter,
    installedDate: roll.installedDate,
    installedByName: roll.installedByName,
    status: roll.status,
    finishedDate: roll.finishedDate,
    usedM,
    remainingM,
    wasteM: roll.wasteM,
    avgRatePerMeter,
    marginPerMeter,
    undercharged: marginPerMeter != null && marginPerMeter < 0,
  };
}

// ── Rolls ────────────────────────────────────────────────────────────────
filmRouter.get('/rolls', async (_req, res) => {
  const rolls = await prisma.filmRoll.findMany({ include: { usages: true }, orderBy: { id: 'desc' } });
  res.json(rolls.map(serializeRoll));
});

// Film purchases already logged under Finance → Expenses (category "DTF
// Film Rolls", with an invoice/receipt number on file) that haven't yet
// been used to install a roll — the "pick from a dropdown" side of feeding
// film. An expense drops off this list the moment it's linked to a roll,
// since FilmRoll.expenseId is unique — one purchase funds exactly one roll.
filmRouter.get('/available-expenses', async (_req, res) => {
  const linked = await prisma.filmRoll.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } });
  const linkedIds = linked.map((r) => r.expenseId as number);
  const expenses = await prisma.expense.findMany({
    where: { category: 'DTF Film Rolls', invoiceNumber: { not: null }, id: { notIn: linkedIds } },
    orderBy: { date: 'desc' },
  });
  res.json(expenses.map((e) => ({ id: e.id, date: e.date, invoiceNumber: e.invoiceNumber, amount: e.amount, note: e.note })));
});

// Installing a roll either logs a brand-new purchase (creating its Expense
// right here, category "DTF Film Rolls") or links an already-logged one
// picked from /available-expenses — either way every roll ends up with an
// invoice/receipt number and a linked Expense, so film purchases always
// post to the P&L. Whichever mode, installing also retires whichever roll
// is currently Active: if that roll still shows a positive remaining
// balance (usage under-logged vs. what physically ran through the
// machine), the shortfall is booked as waste right here — the "system
// still thinks film's there but the roll is physically done" case — and
// its avgRatePerMeter is snapshotted from its own usage history before
// it's retired.
const installRollSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('new'),
    lengthM: z.number().positive(),
    costTotal: z.number().positive(),
    invoiceNumber: z.string().min(1, 'Invoice/receipt number is required'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    mode: z.literal('existing'),
    lengthM: z.number().positive(),
    expenseId: z.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
]);

filmRouter.post('/rolls', async (req, res) => {
  const parsed = installRollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = parsed.data;
  const date = data.date ?? todayStr();

  let costTotal: number;
  let invoiceNumber: string;
  let expenseIdToLink: number | null = null;
  let expenseToCreate: { note: string; amount: number; invoiceNumber: string } | null = null;

  if (data.mode === 'new') {
    const balance = await computePettyCashBalance();
    if (data.costTotal > balance) {
      return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(balance).toLocaleString('en-KE')} available, Ksh ${Math.round(data.costTotal).toLocaleString('en-KE')} needed)` });
    }
    costTotal = data.costTotal;
    invoiceNumber = data.invoiceNumber;
    expenseToCreate = { note: `Film roll — invoice/receipt ${data.invoiceNumber}`, amount: data.costTotal, invoiceNumber: data.invoiceNumber };
  } else {
    const expense = await prisma.expense.findUnique({ where: { id: data.expenseId } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.category !== 'DTF Film Rolls') return res.status(400).json({ error: 'That expense is not a film roll purchase' });
    if (!expense.invoiceNumber) return res.status(400).json({ error: 'That expense has no invoice/receipt number recorded' });
    const alreadyLinked = await prisma.filmRoll.findFirst({ where: { expenseId: expense.id } });
    if (alreadyLinked) return res.status(400).json({ error: 'That expense has already been used to install a film roll' });
    costTotal = expense.amount;
    invoiceNumber = expense.invoiceNumber;
    expenseIdToLink = expense.id;
  }

  const newRoll = await prisma.$transaction(async (tx) => {
    const active = await tx.filmRoll.findFirst({ where: { status: 'Active' }, include: { usages: true } });
    if (active) {
      const usedM = active.usages.reduce((a, u) => a + u.lengthM, 0);
      const remainingM = Math.max(0, active.lengthM - usedM);
      const avgRatePerMeter = weightedAvgRate(active.usages);
      await tx.filmRoll.update({
        where: { id: active.id },
        data: { status: 'Finished', finishedDate: todayStr(), wasteM: remainingM, avgRatePerMeter },
      });
    }

    let finalExpenseId = expenseIdToLink;
    if (expenseToCreate) {
      const created = await tx.expense.create({
        data: { date, category: 'DTF Film Rolls', note: expenseToCreate.note, amount: expenseToCreate.amount, invoiceNumber: expenseToCreate.invoiceNumber, capturedByName: req.user!.name },
      });
      finalExpenseId = created.id;
    }

    return tx.filmRoll.create({
      data: { lengthM: data.lengthM, costTotal, invoiceNumber, expenseId: finalExpenseId, installedDate: date, installedByName: req.user!.name },
      include: { usages: true },
    });
  });

  res.status(201).json(serializeRoll(newRoll));
});

// ── Usage log ────────────────────────────────────────────────────────────
filmRouter.get('/usage', async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const where: Prisma.FilmUsageWhereInput = {};
  if (from) where.date = { ...(where.date as object), gte: from };
  if (to) where.date = { ...(where.date as object), lte: to };

  const usages = await prisma.filmUsage.findMany({
    where,
    include: { order: true },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: 300,
  });
  res.json(
    usages.map((u) => ({
      id: u.id,
      date: u.date,
      lengthM: u.lengthM,
      source: u.source,
      orderId: u.orderId,
      orderNo: u.order?.orderNo ?? null,
      ratePerMeter: u.ratePerMeter,
      revenue: u.ratePerMeter != null ? u.ratePerMeter * u.lengthM : null,
      note: u.note,
      capturedByName: u.capturedByName,
    })),
  );
});

const manualUsageSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lengthM: z.number().positive(),
  ratePerMeter: z.number().nonnegative().optional(),
  note: z.string().max(200).optional(),
});

// The "feed film into the machine" dialog — logs a length fed off the
// active roll outside of an order (a test print, a job not run through the
// POS, or a manual correction). Same decrement as order-triggered usage.
filmRouter.post('/usage', async (req, res) => {
  const parsed = manualUsageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const active = await prisma.filmRoll.findFirst({ where: { status: 'Active' } });
  if (!active) return res.status(400).json({ error: 'Install a film roll before logging usage' });

  const usage = await prisma.filmUsage.create({
    data: {
      filmRollId: active.id,
      date: parsed.data.date,
      lengthM: parsed.data.lengthM,
      source: 'Manual',
      ratePerMeter: parsed.data.ratePerMeter ?? null,
      note: parsed.data.note ?? '',
      capturedByName: req.user!.name,
    },
  });
  res.status(201).json(usage);
});

// ── DTF Print Queue ──────────────────────────────────────────────────────
// Small DTF artworks are often gang-sheeted together — possibly across
// different clients/orders — into one press run rather than run
// individually. Each order/line item is still billed separately (that's
// unaffected by how they're physically batched); this just surfaces what's
// accumulated and not yet run, so staff know when it's worth firing up the
// press instead of running a mostly-empty sheet.
filmRouter.get('/print-queue', async (_req, res) => {
  const items = await prisma.orderLineItem.findMany({
    where: {
      printedAt: null,
      itemType: 'service',
      artworkAreaSqm: { not: null },
      order: { status: { not: 'Quote' } },
      service: { tracksFilm: true, unit: 'sqm' },
    },
    include: { order: { include: { corporateClient: true } }, service: true },
    orderBy: { id: 'asc' },
  });

  const rows = items.map((li) => {
    const totalAreaSqm = (li.artworkAreaSqm ?? 0) * li.qty;
    return {
      id: li.id,
      orderId: li.orderId,
      orderNo: li.order.orderNo,
      clientName: li.order.kind === 'corporate' ? li.order.corporateClient?.name ?? '—' : li.order.customerName ?? '—',
      date: li.order.createdDate,
      serviceName: li.service!.name,
      artworkAreaSqm: li.artworkAreaSqm as number,
      qty: li.qty,
      totalAreaSqm,
      heatPressFee: li.heatPressFee,
    };
  });

  const totalPendingSqm = rows.reduce((a, r) => a + r.totalAreaSqm, 0);
  res.json({
    items: rows,
    totalPendingSqm,
    batchThresholdSqm: DTF_PRINT_QUEUE_BATCH_SQM,
    readyToRun: totalPendingSqm >= DTF_PRINT_QUEUE_BATCH_SQM,
  });
});

const markPrintedSchema = z.object({ lineItemIds: z.array(z.number().int()).min(1) });

// Staff select whichever queued artworks actually went into one press run
// (usually "select all" once the batch is ready) and mark them printed
// together — this doesn't touch billing or film usage, both already
// happened at order capture; it only clears them off the queue.
filmRouter.post('/print-queue/mark-printed', async (req, res) => {
  const parsed = markPrintedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const result = await prisma.orderLineItem.updateMany({
    where: { id: { in: parsed.data.lineItemIds }, printedAt: null },
    data: { printedAt: new Date() },
  });
  res.json({ updated: result.count });
});

// ── Internal helper, used by the orders router ──────────────────────────
// Not an HTTP route — called from within the same order-creation/conversion
// transaction so film depletion is atomic with the order it came from.
export async function logFilmUsageForOrder(
  tx: Prisma.TransactionClient,
  params: {
    orderId: number;
    date: string;
    capturedByName: string;
    lineItems: { serviceId: number | null | undefined; filmLengthM: number | null | undefined; lineTotal: number }[];
  },
) {
  const filmLines = params.lineItems.filter(
    (li): li is typeof li & { serviceId: number; filmLengthM: number } => !!li.serviceId && !!li.filmLengthM && li.filmLengthM > 0,
  );
  if (filmLines.length === 0) return;

  const serviceIds = [...new Set(filmLines.map((li) => li.serviceId))];
  const services = await tx.service.findMany({ where: { id: { in: serviceIds } } });
  const trackedIds = new Set(services.filter((s) => s.tracksFilm).map((s) => s.id));
  const toLog = filmLines.filter((li) => trackedIds.has(li.serviceId));
  if (toLog.length === 0) return;

  const activeRoll = await tx.filmRoll.findFirst({ where: { status: 'Active' } });

  for (const li of toLog) {
    await tx.filmUsage.create({
      data: {
        filmRollId: activeRoll?.id ?? null,
        date: params.date,
        lengthM: li.filmLengthM,
        source: 'Order',
        orderId: params.orderId,
        ratePerMeter: li.filmLengthM > 0 ? li.lineTotal / li.filmLengthM : null,
        note: activeRoll ? '' : 'No active film roll installed at capture time',
        capturedByName: params.capturedByName,
      },
    });
  }
}
