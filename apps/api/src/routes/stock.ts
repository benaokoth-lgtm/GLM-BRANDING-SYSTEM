import { Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES } from '@glm/shared';

export const stockRouter = Router();
stockRouter.use(requireAuth, requireRole(...MANAGEMENT_ROLES));

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
stockRouter.post('/requisitions/:id/approve', requireRole(...FINANCE_ROLES), async (req, res) => {
  await decideRequisition(Number(req.params.id), true, req.user!.name, res);
});

stockRouter.post('/requisitions/:id/reject', requireRole(...FINANCE_ROLES), async (req, res) => {
  await decideRequisition(Number(req.params.id), false, req.user!.name, res);
});
