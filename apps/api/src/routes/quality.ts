import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { STAGE_IN_PRODUCTION, STAGE_QUALITY, STAGE_READY, todayStr } from '@glm/shared';
import { ensureProductionOnce, orderForProductionInclude, productionSummary } from '../production';

// Quality control: every finished order is inspected before it can go to the customer. A pass makes it "Ready for Pickup/
// Delivery"; a fail sends it back to Production as rework. The person who made a job can't be the one who passes it. Like
// Production, Quality can never declare an order completed — completion is the customer handover.
export const qualityRouter = Router();
qualityRouter.use(requireAuth, requirePermission('canAccessQuality'), async (_req, _res, next) => {
  await ensureProductionOnce();
  next();
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

qualityRouter.get('/queue', async (req, res) => {
  const from = typeof req.query.from === 'string' && dateStr.safeParse(req.query.from).success ? (req.query.from as string) : `${todayStr().slice(0, 8)}01`;
  const to = typeof req.query.to === 'string' && dateStr.safeParse(req.query.to).success ? (req.query.to as string) : todayStr();

  const orders = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, stage: STAGE_QUALITY },
    include: { ...orderForProductionInclude, productionTasks: { where: { status: 'Finished' }, include: { assignee: true }, orderBy: { finishedAt: 'desc' }, take: 1 } },
    orderBy: { id: 'asc' },
  });
  const awaiting = orders.map((o) => {
    const t = o.productionTasks[0];
    return {
      ...productionSummary(o),
      producerId: t?.assigneeId ?? null,
      producerName: t?.assignee.name ?? 'Not recorded',
      finishedAt: t?.finishedAt ?? null,
      unitsCompleted: t?.unitsCompleted ?? null,
      isRework: t?.isRework ?? false,
      // The person who made it can't inspect it (Admin, who may be the only person on site, is exempt).
      canInspect: !(t && t.assigneeId === req.user!.id && req.user!.role !== 'Admin'),
    };
  });

  const lo = new Date(`${from}T00:00:00.000Z`);
  const hi = new Date(`${to}T23:59:59.999Z`);
  const checks = await prisma.qualityCheck.findMany({
    where: { checkedAt: { gte: lo, lte: hi } },
    include: { order: { select: { orderNo: true } }, inspector: true, task: { include: { assignee: true } } },
    orderBy: { checkedAt: 'desc' },
    take: 200,
  });
  const passed = checks.filter((c) => c.result === 'Passed').length;
  res.json({
    from,
    to,
    awaiting,
    history: checks.slice(0, 60).map((c) => ({
      id: c.id,
      orderNo: c.order.orderNo,
      result: c.result,
      checkedAt: c.checkedAt,
      inspectorName: c.inspector.name,
      producerName: c.task?.assignee.name ?? '',
      unitsInspected: c.unitsInspected,
      unitsRejected: c.unitsRejected,
      defects: c.defects,
      note: c.note,
      isRework: c.task?.isRework ?? false,
    })),
    stats: {
      checked: checks.length,
      passed,
      failed: checks.length - passed,
      passPct: checks.length ? Math.round((passed / checks.length) * 1000) / 10 : null,
      rejectedUnits: Math.round(checks.reduce((a, c) => a + c.unitsRejected, 0) * 10) / 10,
    },
  });
});

const checkSchema = z.object({
  result: z.enum(['Passed', 'Failed']),
  unitsInspected: z.number().min(0).optional().nullable(),
  unitsRejected: z.number().min(0).optional(),
  defects: z.string().max(300).optional(),
  note: z.string().max(300).optional(),
});

qualityRouter.post('/orders/:orderId/check', async (req, res) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  if (d.result === 'Failed' && !(d.defects || d.note)?.trim()) return res.status(400).json({ error: 'Say what is wrong, so it can be put right' });
  if (d.unitsInspected != null && (d.unitsRejected ?? 0) > d.unitsInspected) return res.status(400).json({ error: 'More units were rejected than were inspected' });

  const order = await prisma.order.findUnique({ where: { id: Number(req.params.orderId) }, include: { lineItems: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.stage !== STAGE_QUALITY) return res.status(400).json({ error: `This order is at “${order.stage}” — only a finished order waiting in Quality Check can be inspected` });

  const task = await prisma.productionTask.findFirst({ where: { orderId: order.id, status: 'Finished' }, orderBy: { finishedAt: 'desc' } });
  if (task && task.assigneeId === req.user!.id && req.user!.role !== 'Admin') {
    return res.status(400).json({ error: 'You made this job — another person has to inspect it' });
  }

  const rejected = d.unitsRejected ?? 0;
  await prisma.$transaction(async (tx) => {
    await tx.qualityCheck.create({
      data: {
        orderId: order.id,
        taskId: task?.id ?? null,
        inspectorId: req.user!.id,
        result: d.result,
        unitsInspected: d.unitsInspected ?? null,
        unitsRejected: rejected,
        defects: d.defects ?? '',
        note: d.note ?? '',
      },
    });
    if (d.result === 'Passed') {
      // Passed: ready to go to the customer. (Not "Completed" — that happens at handover.)
      await tx.order.update({ where: { id: order.id }, data: { stage: STAGE_READY } });
      return;
    }
    // Failed: straight back to the person who made it, as rework for the units that were rejected (or the whole job).
    await tx.order.update({ where: { id: order.id }, data: { stage: STAGE_IN_PRODUCTION } });
    if (task) {
      await tx.productionTask.create({
        data: {
          orderId: order.id,
          assigneeId: task.assigneeId,
          assignedByName: `Quality control (${req.user!.name})`,
          isRework: true,
          unitsPlanned: rejected > 0 ? rejected : task.unitsPlanned,
          note: `Rework: ${(d.defects || d.note || '').trim()}`.slice(0, 300),
        },
      });
    }
  });

  res.status(201).json({ ok: true, nextStage: d.result === 'Passed' ? STAGE_READY : STAGE_IN_PRODUCTION });
});
