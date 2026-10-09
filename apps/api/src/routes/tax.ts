import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { computeYear, loadTaxConfig } from '../incomeTax';

// Income tax (Compliance → Corporation tax). Anyone with Finance access can read the working and the payment schedule; only an Admin changes the
// settings, the adjustments or records a payment to KRA.
export const taxRouter = Router();
taxRouter.use(requireAuth, requirePermission('canAccessFinance'));

const yearSchema = z.coerce.number().int().min(2000).max(2100);
const money = z.number().min(0).max(1e12);

taxRouter.get('/settings', async (_req, res) => {
  res.json(await loadTaxConfig());
});

const settingsSchema = z.object({
  regime: z.enum(['corporation', 'turnover']),
  corporationRate: z.number().min(0).max(100),
  turnoverRate: z.number().min(0).max(100),
  yearEndMonth: z.number().int().min(1).max(12),
});

taxRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' });
  await prisma.taxSettings.upsert({ where: { id: 1 }, update: parsed.data, create: { id: 1, ...parsed.data } });
  res.json(await loadTaxConfig());
});

taxRouter.get('/year/:year', async (req, res) => {
  const year = yearSchema.safeParse(req.params.year);
  if (!year.success) return res.status(400).json({ error: 'Enter a valid year' });
  res.json(await computeYear(year.data, await loadTaxConfig()));
});

const adjustSchema = z.object({
  addBacks: money,
  capitalAllowances: money,
  lossesUsed: money,
  whtCredits: money,
  /** The tax the instalments are based on; null goes back to the suggested figure. */
  estimateTax: money.nullable(),
  note: z.string().trim().max(500).default(''),
});

taxRouter.put('/year/:year', requireRole('Admin'), async (req, res) => {
  const year = yearSchema.safeParse(req.params.year);
  if (!year.success) return res.status(400).json({ error: 'Enter a valid year' });
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid figures' });
  const data = { ...parsed.data, updatedByName: req.user!.name };
  await prisma.taxYear.upsert({ where: { year: year.data }, update: data, create: { year: year.data, ...data } });
  res.json(await computeYear(year.data, await loadTaxConfig()));
});

const paymentSchema = z.object({
  /** I1–I4: the instalments; FINAL: the balance; YYYY-MM: turnover tax for that month. */
  period: z.string().regex(/^(I[1-4]|FINAL|\d{4}-(0[1-9]|1[0-2]))$/, 'Choose what the payment is for'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date paid'),
  amount: z.number().positive().max(1e12),
  reference: z.string().trim().max(120).default(''),
  note: z.string().trim().max(300).default(''),
});

taxRouter.post('/year/:year/payments', requireRole('Admin'), async (req, res) => {
  const year = yearSchema.safeParse(req.params.year);
  if (!year.success) return res.status(400).json({ error: 'Enter a valid year' });
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid payment' });
  await prisma.taxPayment.create({ data: { taxYear: year.data, ...parsed.data, capturedByName: req.user!.name } });
  res.status(201).json(await computeYear(year.data, await loadTaxConfig()));
});

taxRouter.delete('/payments/:id', requireRole('Admin'), async (req, res) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Invalid payment' });
  const row = await prisma.taxPayment.findUnique({ where: { id: id.data } });
  if (!row) return res.status(404).json({ error: 'Payment not found' });
  await prisma.taxPayment.delete({ where: { id: row.id } });
  res.json(await computeYear(row.taxYear, await loadTaxConfig()));
});
