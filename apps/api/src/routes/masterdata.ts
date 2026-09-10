import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';

export const masterDataRouter = Router();
masterDataRouter.use(requireAuth);

// ── Staff & Users ───────────────────────────────────────────────────────
masterDataRouter.get('/staff', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

const staffSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['Staff', 'Supervisor', 'Admin']),
  pin: z.string().regex(/^\d{4}$/),
});

masterDataRouter.post('/staff', requireRole('Admin'), async (req, res) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { name, role, pin } = parsed.data;
  const pinHash = await bcrypt.hash(pin, 10);
  const user = await prisma.user.create({ data: { name, role, pinHash } });
  res.status(201).json({ id: user.id, name: user.name, role: user.role });
});

// ── Service Price List ──────────────────────────────────────────────────
masterDataRouter.get('/services', async (_req, res) => {
  res.json(await prisma.service.findMany({ orderBy: { name: 'asc' } }));
});

const serviceSchema = z.object({
  name: z.string().min(1),
  unit: z.enum(['piece', 'metre', 'sqm']),
  price: z.number().positive(),
});

masterDataRouter.post('/services', requireRole('Admin'), async (req, res) => {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  res.status(201).json(await prisma.service.create({ data: parsed.data }));
});

// ── Material Price List ─────────────────────────────────────────────────
masterDataRouter.get('/materials', async (_req, res) => {
  res.json(await prisma.material.findMany({ orderBy: { name: 'asc' } }));
});

const materialSchema = z.object({ name: z.string().min(1), price: z.number().positive() });

masterDataRouter.post('/materials', requireRole('Admin'), async (req, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  res.status(201).json(await prisma.material.create({ data: parsed.data }));
});

// ── Corporate Clients ───────────────────────────────────────────────────
masterDataRouter.get('/corporate-clients', async (_req, res) => {
  res.json(await prisma.corporateClient.findMany({ orderBy: { name: 'asc' } }));
});

const clientSchema = z.object({ name: z.string().min(1), creditDays: z.number().int().positive() });

masterDataRouter.post('/corporate-clients', requireRole('Admin'), async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  res.status(201).json(await prisma.corporateClient.create({ data: parsed.data }));
});

// ── Discount Rules ───────────────────────────────────────────────────────
masterDataRouter.get('/settings', async (_req, res) => {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  res.json({ maxDiscountPct: settings?.maxDiscountPct ?? 15 });
});

masterDataRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const { maxDiscountPct } = req.body as { maxDiscountPct?: number };
  if (typeof maxDiscountPct !== 'number' || maxDiscountPct < 0) {
    return res.status(400).json({ error: 'maxDiscountPct must be a non-negative number' });
  }
  const settings = await prisma.setting.update({ where: { id: 1 }, data: { maxDiscountPct } });
  res.json({ maxDiscountPct: settings.maxDiscountPct });
});
