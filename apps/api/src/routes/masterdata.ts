import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { FINANCE_ROLES, ROLES } from '@glm/shared';

export const masterDataRouter = Router();
masterDataRouter.use(requireAuth);

// ── Staff & Users ───────────────────────────────────────────────────────
masterDataRouter.get('/staff', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

const staffSchema = z.object({
  name: z.string().min(1),
  role: z.enum(ROLES),
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

// Flags whether a service consumes DTF transfer film, and/or charges a
// staff-picked heat press fee — toggled by Admin, same access level as
// adding a service, since these are catalog definition properties rather
// than day-to-day operational values.
const serviceUpdateSchema = z
  .object({ tracksFilm: z.boolean().optional(), chargesPressingFee: z.boolean().optional() })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/services/:id', requireRole('Admin'), async (req, res) => {
  const parsed = serviceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const service = await prisma.service.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json(service);
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

// Reorder level (and price) are editable in place by Admin or the Finance
// roles that also manage Stock — unlike the roster/price-list "add" actions
// above, which stay Admin-only.
const materialUpdateSchema = z
  .object({
    price: z.number().positive().optional(),
    reorderLevel: z.number().min(0).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/materials/:id', requireRole(...FINANCE_ROLES), async (req, res) => {
  const parsed = materialUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const material = await prisma.material.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!material) return res.status(404).json({ error: 'Material not found' });
  res.json(material);
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
function serializeSettings(settings: {
  maxDiscountPct: number;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  logoDataUrl: string | null;
}) {
  return {
    maxDiscountPct: settings.maxDiscountPct,
    companyName: settings.companyName,
    companyAddress: settings.companyAddress,
    companyPhone: settings.companyPhone,
    companyEmail: settings.companyEmail,
    logoDataUrl: settings.logoDataUrl,
  };
}

masterDataRouter.get('/settings', async (_req, res) => {
  const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  res.json(serializeSettings(settings));
});

// Partial update — Master Data's Discount Rules and Company Info tabs each save
// their own subset of fields without needing to resend the other's values.
const settingsSchema = z
  .object({
    maxDiscountPct: z.number().min(0).optional(),
    companyName: z.string().min(1).max(200).optional(),
    companyAddress: z.string().max(500).optional(),
    companyPhone: z.string().max(50).optional(),
    companyEmail: z.string().max(200).optional(),
    // A data: URL logo image, capped well under the 5mb JSON body limit; null clears it.
    logoDataUrl: z.string().max(2_000_000).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1, ...parsed.data }, update: parsed.data });
  res.json(serializeSettings(settings));
});
