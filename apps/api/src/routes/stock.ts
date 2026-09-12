import { Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { todayStr } from '@glm/shared';
import { computePettyCashBalance } from './finance';

export const stockRouter = Router();
stockRouter.use(requireAuth, requirePermission('canAccessStock'));

// Purchases draw from the same "Printing Materials & Consumables" category
// as any other general supplies spend — stock materials (Caps, T-Shirts,
// Polo Shirts, ...) fit that bucket already, so there's no need for a
// dedicated category the way DTF Film Rolls got one (film has its own
// module to filter against; stock purchases don't need that).
const PURCHASE_EXPENSE_CATEGORY = 'Printing Materials & Consumables';

// Requisitions are visible to everyone with Stock access; only Finance roles
// can approve/reject, so an approved requisition (and the stock increase it
// applies) is always finance-authorized even though Supervisor can request.
stockRouter.get('/requisitions', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const requisitions = await prisma.stockRequisition.findMany({
    where: status ? { status } : undefined,
    include: { material: true },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    requisitions.map((r) => ({
      id: r.id,
      materialId: r.materialId,
      materialName: r.material.name,
      qty: r.qty,
      note: r.note,
      status: r.status,
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt,
    })),
  );
});

const requisitionSchema = z.object({
  materialId: z.number().int(),
  qty: z.number().positive(),
  note: z.string().max(200).optional(),
});

stockRouter.post('/requisitions', async (req, res) => {
  const parsed = requisitionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const material = await prisma.material.findUnique({ where: { id: parsed.data.materialId } });
  if (!material) return res.status(400).json({ error: 'Material not found' });

  const requisition = await prisma.stockRequisition.create({
    data: { ...parsed.data, note: parsed.data.note ?? '', requestedByName: req.user!.name },
  });
  res.status(201).json({ ...requisition, materialName: material.name });
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

// ── Purchases — held then released ──────────────────────────────────────
// A purchase captured here is "Held": it's on record as bought/delivered,
// but Material.stockQty does NOT change until a different manager reconciles
// it (requisitioned qty vs. what was actually purchased) and accepts it into
// the store below. Mirrors the same "physical reality is checked before it
// changes the system, and the check stays as an audit trail" pattern already
// used for Film Roll waste-on-replacement and Stock Take.
stockRouter.get('/purchases', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const purchases = await prisma.purchase.findMany({
    where: status ? { status } : undefined,
    include: { material: true, requisition: true },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json(
    purchases.map((p) => ({
      id: p.id,
      requisitionId: p.requisitionId,
      materialId: p.materialId,
      materialName: p.material.name,
      date: p.date,
      supplier: p.supplier,
      qty: p.qty,
      unitCost: p.unitCost,
      totalCost: p.totalCost,
      invoiceNumber: p.invoiceNumber,
      status: p.status,
      requisitionedQty: p.requisitionedQty,
      varianceQty: p.varianceQty,
      acceptedByName: p.acceptedByName,
      acceptedAt: p.acceptedAt,
      rejectReason: p.rejectReason,
      capturedByName: p.capturedByName,
      createdAt: p.createdAt,
    })),
  );
});

// Approved requisitions with no purchase currently in flight (Held or
// Accepted) against them — the "raise a purchase for this" picker. A
// requisition drops off once a purchase is captured for it, and reappears
// only if that purchase is later rejected (free to try again).
stockRouter.get('/requisitions/awaiting-purchase', async (_req, res) => {
  const requisitions = await prisma.stockRequisition.findMany({
    where: { status: 'Approved', purchases: { none: { status: { in: ['Held', 'Accepted'] } } } },
    include: { material: true },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    requisitions.map((r) => ({ id: r.id, materialId: r.materialId, materialName: r.material.name, qty: r.qty, note: r.note, requestedByName: r.requestedByName })),
  );
});

// Already-logged "Printing Materials & Consumables" expenses (with an
// invoice number on file) not yet linked to a purchase — the "pick from a
// dropdown" side of capturing a purchase, same shape as Film's
// /available-expenses.
stockRouter.get('/available-expenses-for-purchase', async (_req, res) => {
  const linked = await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } });
  const linkedIds = linked.map((p) => p.expenseId as number);
  const expenses = await prisma.expense.findMany({
    where: { category: PURCHASE_EXPENSE_CATEGORY, invoiceNumber: { not: null }, id: { notIn: linkedIds } },
    orderBy: { date: 'desc' },
  });
  res.json(expenses.map((e) => ({ id: e.id, date: e.date, invoiceNumber: e.invoiceNumber, amount: e.amount, note: e.note })));
});

const purchaseSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('new'),
    requisitionId: z.number().int().optional(),
    materialId: z.number().int(),
    supplier: z.string().max(200).optional(),
    qty: z.number().positive(),
    unitCost: z.number().positive(),
    invoiceNumber: z.string().min(1, 'Invoice/receipt number is required'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    mode: z.literal('existing'),
    requisitionId: z.number().int().optional(),
    materialId: z.number().int(),
    supplier: z.string().max(200).optional(),
    qty: z.number().positive(),
    expenseId: z.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
]);

stockRouter.post('/purchases', async (req, res) => {
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = parsed.data;

  const material = await prisma.material.findUnique({ where: { id: data.materialId } });
  if (!material) return res.status(400).json({ error: 'Material not found' });

  let requisitionedQty: number | null = null;
  if (data.requisitionId) {
    const requisition = await prisma.stockRequisition.findUnique({ where: { id: data.requisitionId }, include: { purchases: true } });
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    if (requisition.status !== 'Approved') return res.status(400).json({ error: 'Only an approved requisition can be purchased against' });
    if (requisition.purchases.some((p) => p.status === 'Held' || p.status === 'Accepted')) {
      return res.status(400).json({ error: 'This requisition already has a purchase in progress or accepted' });
    }
    requisitionedQty = requisition.qty;
  }

  const date = data.date ?? todayStr();
  let unitCost: number;
  let totalCost: number;
  let invoiceNumber: string | null;
  let expenseIdToLink: number | null = null;
  let expenseToCreate: { note: string; amount: number; invoiceNumber: string } | null = null;

  if (data.mode === 'new') {
    const balance = await computePettyCashBalance();
    const cost = data.qty * data.unitCost;
    if (cost > balance) {
      return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(balance).toLocaleString('en-KE')} available, Ksh ${Math.round(cost).toLocaleString('en-KE')} needed)` });
    }
    unitCost = data.unitCost;
    totalCost = cost;
    invoiceNumber = data.invoiceNumber;
    expenseToCreate = { note: `Stock purchase — ${material.name} — invoice/receipt ${data.invoiceNumber}`, amount: cost, invoiceNumber: data.invoiceNumber };
  } else {
    const expense = await prisma.expense.findUnique({ where: { id: data.expenseId } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.category !== PURCHASE_EXPENSE_CATEGORY) return res.status(400).json({ error: 'That expense is not a stock purchase' });
    if (!expense.invoiceNumber) return res.status(400).json({ error: 'That expense has no invoice/receipt number recorded' });
    const alreadyLinked = await prisma.purchase.findFirst({ where: { expenseId: expense.id } });
    if (alreadyLinked) return res.status(400).json({ error: 'That expense has already been used for a purchase' });
    totalCost = expense.amount;
    unitCost = totalCost / data.qty;
    invoiceNumber = expense.invoiceNumber;
    expenseIdToLink = expense.id;
  }

  const purchase = await prisma.$transaction(async (tx) => {
    let finalExpenseId = expenseIdToLink;
    if (expenseToCreate) {
      const created = await tx.expense.create({
        data: { date, category: PURCHASE_EXPENSE_CATEGORY, note: expenseToCreate.note, amount: expenseToCreate.amount, invoiceNumber: expenseToCreate.invoiceNumber, capturedByName: req.user!.name },
      });
      finalExpenseId = created.id;
    }

    return tx.purchase.create({
      data: {
        requisitionId: data.requisitionId ?? null,
        materialId: data.materialId,
        date,
        supplier: data.supplier ?? '',
        qty: data.qty,
        unitCost,
        totalCost,
        invoiceNumber,
        expenseId: finalExpenseId,
        requisitionedQty,
        capturedByName: req.user!.name,
      },
      include: { material: true },
    });
  });

  res.status(201).json({ ...purchase, materialName: purchase.material.name });
});

// Reconciliation — compares what was requisitioned against what this
// purchase actually recorded, then releases it into the store. The only
// action that ever increases Material.stockQty from a purchase.
stockRouter.post('/purchases/:id/accept', requirePermission('canApproveStock'), async (req, res) => {
  const purchase = await prisma.purchase.findUnique({ where: { id: Number(req.params.id) } });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (purchase.status !== 'Held') return res.status(400).json({ error: 'Purchase is not awaiting acceptance' });
  if (purchase.capturedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot accept a purchase you captured yourself' });
  }

  const varianceQty = purchase.requisitionedQty != null ? purchase.qty - purchase.requisitionedQty : null;

  const [updated] = await prisma.$transaction([
    prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: 'Accepted', varianceQty, acceptedByName: req.user!.name, acceptedAt: new Date() },
      include: { material: true },
    }),
    prisma.material.update({ where: { id: purchase.materialId }, data: { stockQty: { increment: purchase.qty } } }),
  ]);

  res.json({ ...updated, materialName: updated.material.name });
});

const rejectPurchaseSchema = z.object({ reason: z.string().min(1, 'A reason for rejecting is required') });

stockRouter.post('/purchases/:id/reject', requirePermission('canApproveStock'), async (req, res) => {
  const parsed = rejectPurchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const purchase = await prisma.purchase.findUnique({ where: { id: Number(req.params.id) } });
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (purchase.status !== 'Held') return res.status(400).json({ error: 'Purchase is not awaiting acceptance' });
  if (purchase.capturedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot reject a purchase you captured yourself' });
  }

  const updated = await prisma.purchase.update({
    where: { id: purchase.id },
    data: { status: 'Rejected', rejectReason: parsed.data.reason, acceptedByName: req.user!.name, acceptedAt: new Date() },
    include: { material: true },
  });
  res.json({ ...updated, materialName: updated.material.name });
});

// ── China Import Costing → Stock ─────────────────────────────────────────
// The Import Cost Calculator (KRA Full Tax / Consolidator models) computes a
// per-line landed cost in KES entirely client-side; this route just turns
// its output into stock, one Held Purchase per line — reusing the exact
// same held-then-released pipeline as any other purchase above (a different
// finance/general manager/admin must still accept each one before it
// touches Material.stockQty). An import shipment is a single multi-material
// transaction typically settled by bank transfer/LC rather than petty cash,
// so unlike a "new"-mode local purchase these are never linked to an
// Expense (Purchase.expenseId stays null) — same judgment call as Asset
// Register purchases not linking to Expense either.
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

  // A line's Description is matched case-insensitively against the existing
  // Material catalog so re-importing something already stocked (e.g. "Caps")
  // doesn't create a duplicate row — SQLite's Prisma provider has no
  // query-level case-insensitive filter, so the match happens in JS against
  // a name lookup fetched once up front.
  const existingMaterials = await prisma.material.findMany();
  const byLowerName = new Map(existingMaterials.map((m) => [m.name.toLowerCase(), m]));

  const created = await prisma.$transaction(async (tx) => {
    const rows: Array<Awaited<ReturnType<typeof tx.purchase.create>> & { materialName: string }> = [];
    for (const line of lines) {
      const name = line.description.trim();
      let material = byLowerName.get(name.toLowerCase());
      if (!material) {
        material = await tx.material.create({ data: { name, price: Math.round(line.unitCost) } });
        byLowerName.set(name.toLowerCase(), material);
      }
      const purchase = await tx.purchase.create({
        data: {
          materialId: material.id,
          date,
          supplier,
          qty: line.qty,
          unitCost: line.unitCost,
          totalCost: line.totalCost,
          invoiceNumber: reference || null,
          capturedByName: req.user!.name,
        },
      });
      rows.push({ ...purchase, materialName: material.name });
    }
    return rows;
  });

  res.status(201).json(created);
});
