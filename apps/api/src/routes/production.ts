import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { ACTIVE_TASK_STATUSES, STAGE_IN_PRODUCTION, STAGE_QUALITY, STAGE_WAITING, dailyOutput, orderUnits, staffProductivity, todayStr } from '@glm/shared';
import { canWorkProduction, ensureProductionOnce, isProductionManager, orderForProductionInclude, productionSummary } from '../production';

// Production: once an order is captured it is managed here. A manager assigns each order to a staff member; the worker
// starts it, then finishes it and records what they produced; finishing sends it to Quality Control. Nothing in Production can
// declare an order completed — completion is the customer handover, after QC has passed (see POST /orders/:id/handover).
export const productionRouter = Router();
productionRouter.use(requireAuth, requirePermission('canAccessProduction', 'canManageProduction'), async (_req, _res, next) => {
  await ensureProductionOnce();
  next();
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function taskView(t: { id: number; orderId: number; status: string; isRework: boolean; assigneeId: number; assignedAt: Date; startedAt: Date | null; unitsPlanned: number; note: string; assignedByName: string; assignee: { name: string } }, summary: ReturnType<typeof productionSummary>) {
  // The task's own fields come last so its status (Assigned / In Progress) is not hidden by the order's status.
  return {
    ...summary,
    orderStatus: summary.status,
    id: t.id,
    status: t.status,
    isRework: t.isRework,
    assigneeId: t.assigneeId,
    assigneeName: t.assignee.name,
    assignedAt: t.assignedAt,
    startedAt: t.startedAt,
    assignedByName: t.assignedByName,
    unitsPlanned: t.unitsPlanned,
    note: t.note,
  };
}

// ── The queue ─────────────────────────────────────────────────────────────
// Managers see everything: orders waiting to be assigned, and every job in hand. A worker sees only the jobs assigned to them.
productionRouter.get('/queue', async (req, res) => {
  const manager = await isProductionManager(req.user!);
  const [tasks, stageOrders, qualityCount] = await Promise.all([
    prisma.productionTask.findMany({
      where: { status: { in: ACTIVE_TASK_STATUSES }, ...(manager ? {} : { assigneeId: req.user!.id }) },
      include: { assignee: true, order: { include: orderForProductionInclude } },
      orderBy: { assignedAt: 'asc' },
    }),
    manager
      ? prisma.order.findMany({
          where: { status: { not: 'Quote' }, stage: { in: [STAGE_WAITING, STAGE_IN_PRODUCTION] } },
          include: { ...orderForProductionInclude, productionTasks: { where: { status: { in: ACTIVE_TASK_STATUSES } } } },
          orderBy: { id: 'asc' },
        })
      : Promise.resolve([]),
    prisma.order.count({ where: { status: { not: 'Quote' }, stage: STAGE_QUALITY } }),
  ]);

  // Waiting to be assigned: not yet started on, or "in production" with nobody actually assigned (older orders).
  const waiting = stageOrders.filter((o) => o.productionTasks.length === 0).map(productionSummary);

  let staff: { id: number; name: string; role: string; active: number }[] = [];
  if (manager) {
    const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
    const eligible = [];
    for (const u of users) if (await canWorkProduction(u.role)) eligible.push(u);
    const load = await prisma.productionTask.groupBy({ by: ['assigneeId'], where: { status: { in: ACTIVE_TASK_STATUSES } }, _count: true });
    staff = eligible.map((u) => ({ id: u.id, name: u.name, role: u.role, active: load.find((l) => l.assigneeId === u.id)?._count ?? 0 }));
  }

  res.json({
    manager,
    waiting,
    tasks: tasks.map((t) => taskView(t, productionSummary(t.order))),
    awaitingQuality: qualityCount,
    staff,
  });
});

// ── Assign an order to a staff member (or move it to someone else) ────────
const assignSchema = z.object({ assigneeId: z.number().int(), note: z.string().max(200).optional() });

productionRouter.post('/orders/:orderId/assign', async (req, res) => {
  if (!(await isProductionManager(req.user!))) return res.status(403).json({ error: 'Only a production manager can assign orders' });
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const order = await prisma.order.findUnique({ where: { id: Number(req.params.orderId) }, include: { lineItems: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'Quote') return res.status(400).json({ error: 'A quotation has not been accepted yet — it cannot go into production' });
  if (order.stage !== STAGE_WAITING && order.stage !== STAGE_IN_PRODUCTION) {
    return res.status(400).json({ error: `This order is already at “${order.stage}” — it can only be assigned while it is waiting or in production` });
  }
  const assignee = await prisma.user.findUnique({ where: { id: parsed.data.assigneeId } });
  if (!assignee || !(await canWorkProduction(assignee.role))) return res.status(400).json({ error: 'That person is not on the production team' });

  const task = await prisma.$transaction(async (tx) => {
    // Reassigning: the job they were on is taken off them (and kept on record as superseded).
    await tx.productionTask.updateMany({ where: { orderId: order.id, status: { in: ACTIVE_TASK_STATUSES } }, data: { status: 'Superseded' } });
    // Work on an order that has failed quality control is rework, whoever it is (re)assigned to.
    const failedBefore = (await tx.qualityCheck.count({ where: { orderId: order.id, result: 'Failed' } })) > 0;
    await tx.order.update({ where: { id: order.id }, data: { stage: STAGE_IN_PRODUCTION } });
    return tx.productionTask.create({
      data: {
        orderId: order.id,
        assigneeId: assignee.id,
        assignedByName: req.user!.name,
        unitsPlanned: orderUnits(order.lineItems),
        isRework: failedBefore,
        note: parsed.data.note ?? '',
      },
    });
  });
  res.status(201).json({ id: task.id });
});

// ── The worker's actions ──────────────────────────────────────────────────
async function loadTask(req: { params: { id: string }; user?: { id: number; role: string } }) {
  const task = await prisma.productionTask.findUnique({ where: { id: Number(req.params.id) }, include: { order: true } });
  if (!task) return { error: { status: 404, message: 'Job not found' } as const };
  const allowed = task.assigneeId === req.user!.id || (await isProductionManager(req.user!));
  if (!allowed) return { error: { status: 403, message: 'This job is assigned to someone else' } as const };
  return { task };
}

productionRouter.post('/tasks/:id/start', async (req, res) => {
  const found = await loadTask(req);
  if ('error' in found && found.error) return res.status(found.error.status).json({ error: found.error.message });
  const task = found.task!;
  if (task.status !== 'Assigned') return res.status(400).json({ error: task.status === 'In Progress' ? 'This job has already been started' : 'This job is no longer open' });
  await prisma.productionTask.update({ where: { id: task.id }, data: { status: 'In Progress', startedAt: new Date() } });
  res.json({ ok: true });
});

const finishSchema = z.object({ unitsCompleted: z.number().min(0), note: z.string().max(300).optional() });

// Finishing records the output and sends the order to Quality Control. It does NOT complete the order.
productionRouter.post('/tasks/:id/finish', async (req, res) => {
  const parsed = finishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter how many units were produced' });
  const found = await loadTask(req);
  if ('error' in found && found.error) return res.status(found.error.status).json({ error: found.error.message });
  const task = found.task!;
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) return res.status(400).json({ error: 'This job is already finished or no longer open' });
  if (task.order.stage !== STAGE_IN_PRODUCTION) return res.status(400).json({ error: `This order is at “${task.order.stage}”, not in production` });

  const now = new Date();
  await prisma.$transaction([
    prisma.productionTask.update({
      where: { id: task.id },
      data: { status: 'Finished', startedAt: task.startedAt ?? now, finishedAt: now, unitsCompleted: parsed.data.unitsCompleted, note: parsed.data.note ? parsed.data.note : task.note },
    }),
    prisma.order.update({ where: { id: task.orderId }, data: { stage: STAGE_QUALITY } }),
  ]);
  res.json({ ok: true, nextStage: STAGE_QUALITY });
});

// ── Staff productivity ────────────────────────────────────────────────────
productionRouter.get('/productivity', async (req, res) => {
  const manager = await isProductionManager(req.user!);
  const from = typeof req.query.from === 'string' && dateStr.safeParse(req.query.from).success ? (req.query.from as string) : `${todayStr().slice(0, 8)}01`;
  const to = typeof req.query.to === 'string' && dateStr.safeParse(req.query.to).success ? (req.query.to as string) : todayStr();

  const [tasks, checks, users] = await Promise.all([
    prisma.productionTask.findMany({ where: manager ? {} : { assigneeId: req.user!.id }, include: { order: { select: { orderNo: true } } } }),
    prisma.qualityCheck.findMany({ where: { taskId: { not: null } } }),
    prisma.user.findMany(),
  ]);
  const names = new Map(users.map((u) => [u.id, u]));
  const facts = tasks.map((t) => ({
    id: t.id,
    assigneeId: t.assigneeId,
    assignedAt: t.assignedAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    finishedAt: t.finishedAt?.toISOString() ?? null,
    status: t.status,
    isRework: t.isRework,
    unitsPlanned: t.unitsPlanned,
    unitsCompleted: t.unitsCompleted,
  }));
  const rows = staffProductivity(facts, checks.map((c) => ({ taskId: c.taskId, result: c.result, unitsRejected: c.unitsRejected })), from, to)
    .map((r) => ({ ...r, name: names.get(r.assigneeId)?.name ?? 'Unknown', role: names.get(r.assigneeId)?.role ?? '' }))
    .sort((a, b) => b.unitsCompleted - a.unitsCompleted);

  const lo = new Date(`${from}T00:00:00.000Z`);
  const hi = new Date(`${to}T23:59:59.999Z`);
  const recent = tasks
    .filter((t) => t.status === 'Finished' && t.finishedAt && t.finishedAt >= lo && t.finishedAt <= hi)
    .sort((a, b) => (b.finishedAt!.getTime() - a.finishedAt!.getTime()))
    .slice(0, 40)
    .map((t) => ({
      id: t.id,
      orderNo: t.order.orderNo,
      assigneeName: names.get(t.assigneeId)?.name ?? '',
      isRework: t.isRework,
      finishedAt: t.finishedAt,
      hours: t.finishedAt ? Math.round(((t.finishedAt.getTime() - (t.startedAt ?? t.assignedAt).getTime()) / 3_600_000) * 10) / 10 : null,
      unitsPlanned: t.unitsPlanned,
      unitsCompleted: t.unitsCompleted,
    }));

  res.json({
    from,
    to,
    manager,
    rows,
    totals: {
      jobsFinished: rows.reduce((a, r) => a + r.jobsFinished, 0),
      unitsCompleted: Math.round(rows.reduce((a, r) => a + r.unitsCompleted, 0) * 10) / 10,
      failedChecks: rows.reduce((a, r) => a + r.failedChecks, 0),
      active: rows.reduce((a, r) => a + r.active, 0),
    },
    daily: dailyOutput(facts, from, to),
    recent,
  });
});
