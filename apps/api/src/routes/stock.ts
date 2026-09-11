import { Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';

export const stockRouter = Router();
stockRouter.use(requireAuth, requirePermission('canAccessStock'));

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

  if (approve) {
    await prisma.material.update({
      where: { id: requisition.materialId },
      data: { stockQty: { increment: requisition.qty } },
    });
  }

  const updated = await prisma.stockRequisition.update({
    where: { id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: deciderName, decidedAt: new Date() },
  });
  res.json(updated);
}

// Approval requires a Finance role even though Supervisor can view/request —
// this is the "before it becomes available for sale" gate on stock qty.
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
