import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { MANAGEMENT_ROLES, todayStr } from '@glm/shared';

export const filmRouter = Router();
filmRouter.use(requireAuth, requireRole(...MANAGEMENT_ROLES));

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

const installRollSchema = z.object({
  lengthM: z.number().positive(),
  costTotal: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// Installing a new roll retires whichever roll is currently Active. If that
// roll still shows a positive remaining balance (usage under-logged vs. what
// physically ran through the machine), the shortfall is booked as waste
// right here — that's the "system still thinks film's there but the roll is
// physically done" case — and its avgRatePerMeter is snapshotted from its
// own usage history before it's retired.
filmRouter.post('/rolls', async (req, res) => {
  const parsed = installRollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { lengthM, costTotal, date } = parsed.data;

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
    return tx.filmRoll.create({
      data: { lengthM, costTotal, installedDate: date ?? todayStr(), installedByName: req.user!.name },
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
