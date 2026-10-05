import { Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { formatPurchaseOrderRef, nextPurchaseOrderNumber, reconcileRequisition, todayStr } from '@glm/shared';
import type { PurchaseLineInput } from '@glm/shared';
import { computePettyCashBalance } from './finance';
import { ensureRequisitionsOnce, formatRequisitionRef, nextRequisitionNumber } from '../requisitions';
import { ensurePurchasesOnce, nextPoNumber } from '../purchases';

export const stockRouter = Router();
stockRouter.use(requireAuth, requirePermission('canAccessStock'));

// Purchases draw from the same "Printing Materials & Consumables" category
// as any other general supplies spend — stock materials (Caps, T-Shirts,
// Polo Shirts, ...) fit that bucket already, so there's no need for a
// dedicated category for stock purchases.
const PURCHASE_EXPENSE_CATEGORY = 'Printing Materials & Consumables';

// Requisitions are visible to everyone with Stock access; only Finance roles
// can approve/reject, so an approved requisition (and the stock increase it
// applies) is always finance-authorized even though Supervisor can request.
const requisitionInclude = { lines: { include: { material: true }, orderBy: { id: 'asc' as const } } };

stockRouter.get('/requisitions', async (req, res) => {
  await ensureRequisitionsOnce(); // gives older requisitions a reference and turns their one material into a line
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const requisitions = await prisma.stockRequisition.findMany({
    where: status ? { status } : undefined,
    include: requisitionInclude,
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    requisitions.map((r) => ({
      id: r.id,
      ref: r.ref,
      note: r.note,
      status: r.status,
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt,
      lines: r.lines.map((l) => ({ id: l.id, materialId: l.materialId, materialName: l.material.name, qty: l.qty, estUnitCost: l.estUnitCost })),
    })),
  );
});

// A requisition is a reference number plus one or more lines (a material and a quantity each).
const requisitionSchema = z.object({
  note: z.string().max(200).optional(),
  lines: z.array(z.object({ materialId: z.number().int(), qty: z.number().positive(), estUnitCost: z.number().min(0).nullable().optional() })).min(1, 'Add at least one item').max(40),
});

stockRouter.post('/requisitions', async (req, res) => {
  const parsed = requisitionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  // The same material twice on one requisition is one line with the quantities added.
  // (Expected prices are averaged, weighted by quantity, when both lines gave one.)
  const merged = new Map<number, { qty: number; est: number | null }>();
  for (const l of parsed.data.lines) {
    const m = merged.get(l.materialId);
    const est = l.estUnitCost ?? null;
    if (!m) merged.set(l.materialId, { qty: l.qty, est });
    else {
      m.est = m.est != null && est != null ? (m.est * m.qty + est * l.qty) / (m.qty + l.qty) : (est ?? m.est);
      m.qty += l.qty;
    }
  }
  const materials = await prisma.material.findMany({ where: { id: { in: [...merged.keys()] } } });
  if (materials.length !== merged.size) return res.status(400).json({ error: 'A chosen material was not found' });

  await ensureRequisitionsOnce();
  // The reference is the next free number; two people raising one at the same instant would collide on the unique
  // index, so a collision just takes the next number.
  const reqNote = parsed.data.note ?? '';
  let requisition: Awaited<ReturnType<typeof createRequisition>> | null = null;
  async function createRequisition(number: number) {
    return prisma.stockRequisition.create({
      data: {
        ref: formatRequisitionRef(number),
        note: reqNote,
        requestedByName: req.user!.name,
        lines: { create: [...merged.entries()].map(([materialId, m]) => ({ materialId, qty: m.qty, estUnitCost: m.est })) },
      },
      include: requisitionInclude,
    });
  }
  for (let attempt = 0; attempt < 5 && !requisition; attempt++) {
    try {
      requisition = await createRequisition((await nextRequisitionNumber()) + attempt);
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  if (!requisition) return res.status(500).json({ error: 'Could not allocate a reference number — try again' });
  res.status(201).json({
    id: requisition.id,
    ref: requisition.ref,
    note: requisition.note,
    status: requisition.status,
    lines: requisition.lines.map((l) => ({ id: l.id, materialId: l.materialId, materialName: l.material.name, qty: l.qty, estUnitCost: l.estUnitCost })),
  });
});

async function decideRequisition(id: number, approve: boolean, deciderName: string, res: Response) {
  const requisition = await prisma.stockRequisition.findUnique({ where: { id } });
  if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
  if (requisition.status !== 'Pending') return res.status(400).json({ error: 'Requisition has already been decided' });
  if (requisition.requestedByName === deciderName) {
    return res.status(400).json({ error: 'You cannot approve or reject your own requisition' });
  }

  // Approving only authorizes buying it — it no longer touches
  // Material.stockQty directly. That only happens once a purchase against
  // it is captured and then accepted into the store (see the Purchases
  // section below), so "available for sale" always reflects stock that's
  // actually been counted in, not merely requested.
  const updated = await prisma.stockRequisition.update({
    where: { id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: deciderName, decidedAt: new Date() },
  });
  res.json(updated);
}

// Approval requires a Finance role even though Supervisor can view/request.
stockRouter.post('/requisitions/:id/approve', requirePermission('canApproveStock'), async (req, res) => {
  await decideRequisition(Number(req.params.id), true, req.user!.name, res);
});

stockRouter.post('/requisitions/:id/reject', requirePermission('canApproveStock'), async (req, res) => {
  await decideRequisition(Number(req.params.id), false, req.user!.name, res);
});

// ── Stock Take — physical count reconciliation ──────────────────────────
// A count against Material.stockQty as it stands right now; systemQty is
// snapshotted before the correction so the discrepancy stays visible even
// after stockQty is updated to match what's actually on the shelf.
stockRouter.get('/takes', async (_req, res) => {
  const takes = await prisma.stockTake.findMany({ include: { material: true }, orderBy: { countedAt: 'desc' }, take: 200 });
  res.json(
    takes.map((t) => ({
      id: t.id,
      materialId: t.materialId,
      materialName: t.material.name,
      date: t.date,
      systemQty: t.systemQty,
      countedQty: t.countedQty,
      varianceQty: t.varianceQty,
      note: t.note,
      countedByName: t.countedByName,
      countedAt: t.countedAt,
    })),
  );
});

const stockTakeSchema = z.object({
  materialId: z.number().int(),
  countedQty: z.number().min(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(200).optional(),
});

stockRouter.post('/takes', async (req, res) => {
  const parsed = stockTakeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const material = await prisma.material.findUnique({ where: { id: parsed.data.materialId } });
  if (!material) return res.status(400).json({ error: 'Material not found' });

  const systemQty = material.stockQty;
  const varianceQty = parsed.data.countedQty - systemQty;

  const [take] = await prisma.$transaction([
    prisma.stockTake.create({
      data: {
        materialId: material.id,
        date: parsed.data.date ?? new Date().toISOString().slice(0, 10),
        systemQty,
        countedQty: parsed.data.countedQty,
        varianceQty,
        note: parsed.data.note ?? '',
        countedByName: req.user!.name,
      },
    }),
    prisma.material.update({ where: { id: material.id }, data: { stockQty: parsed.data.countedQty } }),
  ]);

  res.status(201).json({ ...take, materialName: material.name });
});

// ── Purchases — held then received ───────────────────────────────────────
// A purchase order (PO-0001…) is captured here with any number of lines — a material, the quantity bought and the real unit price from
// the supplier's invoice. It is "Held": on record as bought, but Material.stockQty does NOT change until the STORE MANAGER receives it,
// entering the quantity of each line that physically arrived. Receiving is the only thing that ever increases stock from a purchase.
// A different person must receive it than captured it. Purchases raised against an approved requisition are reconciled against that
// requisition (see /reconciliation below): quantities and prices asked for, bought, and received.
const lineWithRequisition = { include: { material: true, businessHead: true }, orderBy: { id: 'asc' as const } };

type PurchaseWithRefs = Awaited<ReturnType<typeof loadPurchases>>[number];
async function loadPurchases(where?: Prisma.PurchaseWhereInput, take = 300) {
  return prisma.purchase.findMany({
    where,
    include: { lines: lineWithRequisition, requisition: { include: { lines: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

function serializePurchase(p: PurchaseWithRefs) {
  return {
    id: p.id,
    poRef: p.poRef,
    requisitionId: p.requisitionId,
    requisitionRef: p.requisition?.ref ?? null,
    date: p.date,
    supplier: p.supplier,
    invoiceNumber: p.invoiceNumber,
    status: p.status,
    totalCost: p.totalCost,
    lines: p.lines.map((l) => ({
      id: l.id,
      materialId: l.materialId,
      materialName: l.material.name,
      qty: l.qty,
      unitCost: l.unitCost,
      totalCost: l.totalCost,
      receivedQty: l.receivedQty,
      businessHeadId: l.businessHeadId,
      businessHeadName: l.businessHead?.name ?? null,
      requisitionedQty: p.requisition?.lines.find((rl) => rl.materialId === l.materialId)?.qty ?? null,
    })),
    acceptedByName: p.acceptedByName,
    acceptedAt: p.acceptedAt,
    rejectReason: p.rejectReason,
    receiveNote: p.receiveNote,
    capturedByName: p.capturedByName,
    createdAt: p.createdAt,
  };
}

stockRouter.get('/purchases', async (req, res) => {
  await ensurePurchasesOnce();
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json((await loadPurchases(status ? { status } : undefined)).map(serializePurchase));
});

// Approved requisitions that still have lines nobody has bought (or whose purchase was rejected) — the "raise a purchase order for
// this" picker. A line drops off once a purchase for that material is in flight (Held or Accepted).
stockRouter.get('/requisitions/awaiting-purchase', async (_req, res) => {
  await ensureRequisitionsOnce();
  await ensurePurchasesOnce();
  const requisitions = await prisma.stockRequisition.findMany({
    where: { status: 'Approved' },
    include: { ...requisitionInclude, purchases: { where: { status: { in: ['Held', 'Accepted'] } }, include: { lines: true } } },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    requisitions
      .map((r) => {
        const covered = new Set(r.purchases.flatMap((p) => p.lines.map((l) => l.materialId)));
        return {
          id: r.id,
          ref: r.ref,
          note: r.note,
          requestedByName: r.requestedByName,
          lines: r.lines.filter((l) => !covered.has(l.materialId)).map((l) => ({ lineId: l.id, materialId: l.materialId, materialName: l.material.name, qty: l.qty, estUnitCost: l.estUnitCost })),
        };
      })
      .filter((r) => r.lines.length > 0),
  );
});

// The latest price paid for each material — offered as the expected price when a requisition is raised.
stockRouter.get('/material-costs', async (_req, res) => {
  await ensurePurchasesOnce();
  const lines = await prisma.purchaseLine.findMany({ where: { purchase: { status: { not: 'Rejected' } } }, orderBy: { id: 'desc' }, take: 2000, select: { materialId: true, unitCost: true } });
  const latest: Record<number, number> = {};
  for (const l of lines) if (latest[l.materialId] == null) latest[l.materialId] = l.unitCost;
  res.json(latest);
});

// Already-logged "Printing Materials & Consumables" expenses (with an invoice number on file) not yet linked to a purchase — the
// "pick from a dropdown" side of capturing a purchase.
stockRouter.get('/available-expenses-for-purchase', async (_req, res) => {
  const linked = await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } });
  const linkedIds = linked.map((p) => p.expenseId as number);
  const expenses = await prisma.expense.findMany({
    where: { category: PURCHASE_EXPENSE_CATEGORY, invoiceNumber: { not: null }, id: { notIn: linkedIds } },
    orderBy: { date: 'desc' },
  });
  res.json(expenses.map((e) => ({ id: e.id, date: e.date, invoiceNumber: e.invoiceNumber, amount: e.amount, note: e.note })));
});

// businessHeadId: left out = the material's usual head; null = deliberately not tagged to one.
const purchaseLineSchema = z.object({ materialId: z.number().int(), qty: z.number().positive(), unitCost: z.number().positive('Every line needs the unit price from the invoice'), businessHeadId: z.number().int().nullable().optional() });
const purchaseBase = {
  requisitionId: z.number().int().optional(),
  supplier: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one item').max(40),
};
const purchaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), invoiceNumber: z.string().min(1, 'Invoice/receipt number is required'), ...purchaseBase }),
  z.object({ mode: z.literal('existing'), expenseId: z.number().int(), ...purchaseBase }),
]);

stockRouter.post('/purchases', async (req, res) => {
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = parsed.data;
  await ensurePurchasesOnce();

  // The same material twice on one purchase is one line: quantities add, and the price is the weighted average.
  const merged = new Map<number, { qty: number; total: number; head: number | null | undefined }>();
  for (const l of data.lines) {
    const m = merged.get(l.materialId) ?? { qty: 0, total: 0, head: l.businessHeadId };
    m.qty += l.qty;
    m.total += l.qty * l.unitCost;
    merged.set(l.materialId, m);
  }
  const materials = await prisma.material.findMany({ where: { id: { in: [...merged.keys()] } } });
  if (materials.length !== merged.size) return res.status(400).json({ error: 'A chosen material was not found' });
  const nameOf = new Map(materials.map((m) => [m.id, m.name]));
  const headIds = [...new Set([...merged.values()].map((m) => m.head).filter((h): h is number => h != null))];
  if (headIds.length && (await prisma.businessHead.count({ where: { id: { in: headIds } } })) !== headIds.length) return res.status(400).json({ error: 'A chosen business head does not exist' });
  const materialHead = new Map(materials.map((m) => [m.id, m.businessHeadId]));
  const lines = [...merged.entries()].map(([materialId, m]) => ({
    materialId,
    qty: m.qty,
    totalCost: Math.round(m.total * 100) / 100,
    unitCost: Math.round((m.total / m.qty) * 10000) / 10000,
    businessHeadId: m.head === undefined ? materialHead.get(materialId) ?? null : m.head,
  }));
  // The invoice's expense takes the head when every line is for the same one (the cost report counts the lines, not the expense).
  const heads = new Set(lines.map((l) => l.businessHeadId));
  const expenseHead = heads.size === 1 ? [...heads][0] ?? null : null;
  const total = Math.round(lines.reduce((a, l) => a + l.totalCost, 0) * 100) / 100;

  if (data.requisitionId) {
    await ensureRequisitionsOnce();
    const requisition = await prisma.stockRequisition.findUnique({ where: { id: data.requisitionId }, include: { purchases: { where: { status: { in: ['Held', 'Accepted'] } }, include: { lines: true } } } });
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    if (requisition.status !== 'Approved') return res.status(400).json({ error: 'Only an approved requisition can be purchased against' });
    const covered = new Set(requisition.purchases.flatMap((p) => p.lines.map((l) => l.materialId)));
    const dup = lines.find((l) => covered.has(l.materialId));
    if (dup) return res.status(400).json({ error: `${nameOf.get(dup.materialId)} on ${requisition.ref} already has a purchase in progress or accepted` });
  }

  const date = data.date ?? todayStr();
  let invoiceNumber: string | null;
  let expenseIdToLink: number | null = null;
  let createExpense = false;
  if (data.mode === 'new') {
    const balance = await computePettyCashBalance();
    if (total > balance) {
      return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(balance).toLocaleString('en-KE')} available, Ksh ${Math.round(total).toLocaleString('en-KE')} needed)` });
    }
    invoiceNumber = data.invoiceNumber;
    createExpense = true;
  } else {
    const expense = await prisma.expense.findUnique({ where: { id: data.expenseId } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.category !== PURCHASE_EXPENSE_CATEGORY) return res.status(400).json({ error: 'That expense is not a stock purchase' });
    if (!expense.invoiceNumber) return res.status(400).json({ error: 'That expense has no invoice/receipt number recorded' });
    if (await prisma.purchase.findFirst({ where: { expenseId: expense.id } })) return res.status(400).json({ error: 'That expense has already been used for a purchase' });
    // The lines are the invoice itemised: they must add up to what was recorded as spent.
    if (Math.abs(expense.amount - total) > 1) {
      return res.status(400).json({ error: `The lines add up to Ksh ${total.toLocaleString('en-KE')} but that expense is Ksh ${expense.amount.toLocaleString('en-KE')} — check the quantities and unit prices against the invoice` });
    }
    invoiceNumber = expense.invoiceNumber;
    expenseIdToLink = expense.id;
  }

  // The PO number is the next free one; two people capturing at the same instant would collide on the unique index, so a collision
  // just takes the next number (the whole transaction, expense included, is rolled back and retried).
  let created: Awaited<ReturnType<typeof loadPurchases>>[number] | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const poRef = formatPurchaseOrderRef((await nextPoNumber()) + attempt);
    try {
      const id = await prisma.$transaction(async (tx) => {
        let expenseId = expenseIdToLink;
        if (createExpense) {
          const e = await tx.expense.create({
            data: {
              date,
              category: PURCHASE_EXPENSE_CATEGORY,
              note: `Stock purchase ${poRef} — ${lines.length} item${lines.length === 1 ? '' : 's'} — invoice/receipt ${invoiceNumber}`,
              amount: total,
              invoiceNumber,
              supplier: data.supplier ?? '',
              businessHeadId: expenseHead,
              capturedByName: req.user!.name,
            },
          });
          expenseId = e.id;
        }
        const p = await tx.purchase.create({
          data: {
            poRef,
            requisitionId: data.requisitionId ?? null,
            date,
            supplier: data.supplier ?? '',
            totalCost: total,
            invoiceNumber,
            expenseId,
            capturedByName: req.user!.name,
            lines: { create: lines },
          },
        });
        return p.id;
      });
      created = (await loadPurchases({ id }, 1))[0] ?? null;
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  if (!created) return res.status(500).json({ error: 'Could not allocate a purchase order number — try again' });
  res.status(201).json(serializePurchase(created));
});

// Receiving — the store manager enters what physically arrived, line by line (it defaults to what was purchased). This is the only
// action that ever increases Material.stockQty from a purchase, and it increases it by what was RECEIVED, not what was invoiced.
const receiveSchema = z.object({
  lines: z.array(z.object({ lineId: z.number().int(), receivedQty: z.number().min(0) })).optional(),
  note: z.string().max(300).optional(),
});
const receivers = requirePermission('canReceiveStock', 'canApproveStock');

stockRouter.post('/purchases/:id/accept', receivers, async (req, res) => {
  const parsed = receiveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensurePurchasesOnce();
  const purchase = await prisma.purchase.findUnique({ where: { id: Number(req.params.id) }, include: { lines: true } });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (purchase.status !== 'Held') return res.status(400).json({ error: 'Purchase is not awaiting receipt' });
  if (purchase.capturedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot receive a purchase you captured yourself' });
  }
  const given = new Map((parsed.data.lines ?? []).map((l) => [l.lineId, l.receivedQty]));
  for (const id of given.keys()) if (!purchase.lines.some((l) => l.id === id)) return res.status(400).json({ error: 'A line does not belong to this purchase' });

  await prisma.$transaction(async (tx) => {
    for (const line of purchase.lines) {
      const received = given.get(line.id) ?? line.qty;
      await tx.purchaseLine.update({ where: { id: line.id }, data: { receivedQty: received } });
      if (received > 0) await tx.material.update({ where: { id: line.materialId }, data: { stockQty: { increment: received } } });
    }
    await tx.purchase.update({ where: { id: purchase.id }, data: { status: 'Accepted', acceptedByName: req.user!.name, acceptedAt: new Date(), receiveNote: parsed.data.note?.trim() || null } });
  });
  res.json(serializePurchase((await loadPurchases({ id: purchase.id }, 1))[0]!));
});

const rejectPurchaseSchema = z.object({ reason: z.string().min(1, 'A reason for rejecting is required') });

stockRouter.post('/purchases/:id/reject', receivers, async (req, res) => {
  const parsed = rejectPurchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const purchase = await prisma.purchase.findUnique({ where: { id: Number(req.params.id) } });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (purchase.status !== 'Held') return res.status(400).json({ error: 'Purchase is not awaiting receipt' });
  if (purchase.capturedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot reject a purchase you captured yourself' });
  }
  await prisma.purchase.update({ where: { id: purchase.id }, data: { status: 'Rejected', rejectReason: parsed.data.reason, acceptedByName: req.user!.name, acceptedAt: new Date() } });
  res.json(serializePurchase((await loadPurchases({ id: purchase.id }, 1))[0]!));
});

// Tagging a purchase line to a line of business (or clearing it) changes no quantity or cost.
stockRouter.patch('/purchases/lines/:id/business-head', async (req, res) => {
  const parsed = z.object({ businessHeadId: z.number().int().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a business head, or none' });
  if (parsed.data.businessHeadId != null && !(await prisma.businessHead.findUnique({ where: { id: parsed.data.businessHeadId } }))) return res.status(400).json({ error: 'That business head does not exist' });
  const line = await prisma.purchaseLine.update({ where: { id: Number(req.params.id) }, data: { businessHeadId: parsed.data.businessHeadId } }).catch(() => null);
  if (!line) return res.status(404).json({ error: 'Purchase line not found' });
  res.json(line);
});

// ── Purchases reconciliation ─────────────────────────────────────────────
// For every approved requisition: what was requisitioned (quantity and expected price) against what was bought and what the store
// manager physically received — with the variance in quantity, price and total, per line and per requisition reference. Purchases made
// with no requisition at all are listed separately, because spending nobody asked for is what this report exists to show.
stockRouter.get('/reconciliation', async (req, res) => {
  await ensureRequisitionsOnce();
  await ensurePurchasesOnce();
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  const onlyVariance = req.query.variance === '1';

  const requisitions = await prisma.stockRequisition.findMany({
    where: {
      status: 'Approved',
      ...(from || to ? { requestedAt: { ...(from ? { gte: new Date(from + 'T00:00:00') } : {}), ...(to ? { lte: new Date(to + 'T23:59:59') } : {}) } } : {}),
    },
    include: { lines: { include: { material: true }, orderBy: { id: 'asc' } }, purchases: { where: { status: { not: 'Rejected' } }, include: { lines: { include: { material: true } } }, orderBy: { id: 'asc' } } },
    orderBy: { requestedAt: 'desc' },
  });

  const rows = requisitions.map((r) => {
    const purchaseLines: PurchaseLineInput[] = r.purchases.flatMap((p) =>
      p.lines.map((l) => ({ materialId: l.materialId, name: l.material.name, qty: l.qty, unitCost: l.unitCost, totalCost: l.totalCost, receivedQty: l.receivedQty, status: (p.status === 'Accepted' ? 'Accepted' : 'Held') as 'Held' | 'Accepted' })),
    );
    const { lines, totals } = reconcileRequisition(
      r.lines.map((l) => ({ materialId: l.materialId, name: l.material.name, qty: l.qty, estUnitCost: l.estUnitCost })),
      purchaseLines,
    );
    const state = r.purchases.length === 0 ? 'Not purchased' : lines.some((l) => l.status === 'Not purchased') ? 'Part purchased' : lines.some((l) => l.status === 'Awaiting receipt') ? 'Awaiting receipt' : 'Received';
    return {
      id: r.id,
      ref: r.ref,
      note: r.note,
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt,
      decidedByName: r.decidedByName,
      state,
      purchaseOrders: r.purchases.map((p) => ({ id: p.id, poRef: p.poRef, status: p.status, supplier: p.supplier, invoiceNumber: p.invoiceNumber, totalCost: p.totalCost, date: p.date })),
      lines,
      totals,
    };
  });

  const filtered = onlyVariance ? rows.filter((r) => r.totals.totalVariance !== 0 || r.lines.some((l) => (l.qtyVariance ?? 0) !== 0 || l.shortDelivery !== 0)) : rows;

  const standalone = await prisma.purchase.findMany({
    where: { requisitionId: null, status: { not: 'Rejected' }, ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    include: { lines: { include: { material: true } } },
    orderBy: { id: 'desc' },
    take: 200,
  });

  res.json({
    requisitions: filtered,
    summary: {
      requisitions: filtered.length,
      expectedTotal: Math.round(filtered.reduce((a, r) => a + r.totals.expectedTotal, 0) * 100) / 100,
      actualTotal: Math.round(filtered.reduce((a, r) => a + r.totals.actualTotal, 0) * 100) / 100,
      totalVariance: Math.round(filtered.reduce((a, r) => a + r.totals.totalVariance, 0) * 100) / 100,
      priceVarianceValue: Math.round(filtered.reduce((a, r) => a + r.totals.priceVarianceValue, 0) * 100) / 100,
      qtyVarianceValue: Math.round(filtered.reduce((a, r) => a + r.totals.qtyVarianceValue, 0) * 100) / 100,
      shortDeliveryValue: Math.round(filtered.reduce((a, r) => a + r.totals.shortDeliveryValue, 0) * 100) / 100,
    },
    standalone: standalone.map((p) => ({
      id: p.id,
      poRef: p.poRef,
      date: p.date,
      supplier: p.supplier,
      invoiceNumber: p.invoiceNumber,
      status: p.status,
      totalCost: p.totalCost,
      items: p.lines.map((l) => `${l.material.name} × ${l.qty}`).join(', '),
    })),
  });
});

// ── China Import Costing → Stock ─────────────────────────────────────────
// The Import Cost Calculator (KRA Full Tax / Consolidator models) computes a per-line landed cost in KES entirely client-side; this
// route turns its output into ONE purchase order with a line per material, reusing the same held-then-received pipeline as any other
// purchase above (someone else must still receive it, entering what arrived, before it touches Material.stockQty). An import shipment is
// a single multi-material transaction typically settled by bank transfer/LC rather than petty cash, so unlike a "new"-mode local
// purchase it is never linked to an Expense (Purchase.expenseId stays null).
const importLineSchema = z.object({
  description: z.string().min(1),
  qty: z.number().positive(),
  unitCost: z.number().positive(),
  totalCost: z.number().positive(),
});

const importBatchSchema = z.object({
  model: z.enum(['kra', 'consolidator']),
  reference: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(importLineSchema).min(1),
});

stockRouter.post('/imports', async (req, res) => {
  const parsed = importBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { model, lines } = parsed.data;
  const date = parsed.data.date ?? todayStr();
  const reference = parsed.data.reference?.trim() || '';
  const supplier = `China Import (${model === 'kra' ? 'KRA Full Tax' : 'Consolidator'})${reference ? ' — ' + reference : ''}`;
  await ensurePurchasesOnce();

  // A line's Description is matched case-insensitively against the existing Material catalog so re-importing something already stocked
  // (e.g. "Caps") doesn't create a duplicate row.
  const existingMaterials = await prisma.material.findMany();
  const byLowerName = new Map(existingMaterials.map((m) => [m.name.toLowerCase(), m]));

  const created = await prisma.$transaction(async (tx) => {
    const resolved: { materialId: number; materialName: string; qty: number; unitCost: number; totalCost: number; businessHeadId: number | null }[] = [];
    for (const line of lines) {
      const name = line.description.trim();
      let material = byLowerName.get(name.toLowerCase());
      if (!material) {
        material = await tx.material.create({ data: { name, price: Math.round(line.unitCost) } });
        byLowerName.set(name.toLowerCase(), material);
      }
      resolved.push({ materialId: material.id, materialName: material.name, qty: line.qty, unitCost: line.unitCost, totalCost: line.totalCost, businessHeadId: material.businessHeadId });
    }
    const existing = await tx.purchase.findMany({ where: { poRef: { not: null } }, select: { poRef: true } });
    const poRef = formatPurchaseOrderRef(nextPurchaseOrderNumber(existing.map((p) => p.poRef)));
    const purchase = await tx.purchase.create({
      data: {
        poRef,
        date,
        supplier,
        invoiceNumber: reference || null,
        totalCost: Math.round(resolved.reduce((a, l) => a + l.totalCost, 0) * 100) / 100,
        capturedByName: req.user!.name,
        lines: { create: resolved.map(({ materialId, qty, unitCost, totalCost, businessHeadId }) => ({ materialId, qty, unitCost, totalCost, businessHeadId })) },
      },
    });
    return resolved.map((l) => ({ ...l, purchaseId: purchase.id, poRef }));
  });

  res.status(201).json(created);
});
