import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from '@glm/shared';

export const masterDataRouter = Router();
masterDataRouter.use(requireAuth);

// ── Staff & Users ───────────────────────────────────────────────────────
masterDataRouter.get('/staff', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

const staffSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/),
});

masterDataRouter.post('/staff', requireRole('Admin'), async (req, res) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { name, role, pin } = parsed.data;
  if (role !== 'Admin') {
    const roleExists = await prisma.role.findUnique({ where: { name: role } });
    if (!roleExists) return res.status(400).json({ error: 'Unknown role — add it under Roles & Access first' });
  }
  const pinHash = await bcrypt.hash(pin, 10);
  const user = await prisma.user.create({ data: { name, role, pinHash } });
  res.status(201).json({ id: user.id, name: user.name, role: user.role });
});

// ── Roles & Access — Admin-only, same level as every other Master Data ──
// mutation. 'Admin' itself isn't a row here: it's always all-permissions by
// server rule (see permissions.ts), so there's nothing to configure for it —
// listing it as a phantom row would only invite someone to "edit" it and be
// confused when nothing changes.
masterDataRouter.get('/roles', requireRole('Admin'), async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  res.json(
    roles.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, r[k]])),
    })),
  );
});

const roleSchema = z.object({
  name: z.string().min(1).max(60),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

function permissionFields(permissions: Record<string, boolean> | undefined) {
  const out: Record<string, boolean> = {};
  for (const k of PERMISSION_KEYS) out[k] = permissions?.[k] ?? false;
  return out;
}

masterDataRouter.post('/roles', requireRole('Admin'), async (req, res) => {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (parsed.data.name === 'Admin') return res.status(400).json({ error: '"Admin" is reserved and always has full access' });
  const role = await prisma.role
    .create({ data: { name: parsed.data.name, ...permissionFields(parsed.data.permissions ?? DEFAULT_ROLE_PERMISSIONS.Staff) } })
    .catch(() => null);
  if (!role) return res.status(400).json({ error: 'A role with that name already exists' });
  res.status(201).json({ id: role.id, name: role.name, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, role[k]])) });
});

const roleUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

masterDataRouter.put('/roles/:id', requireRole('Admin'), async (req, res) => {
  const parsed = roleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const existing = await prisma.role.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (parsed.data.name === 'Admin') return res.status(400).json({ error: '"Admin" is reserved and always has full access' });

  const data: Record<string, unknown> = {};
  if (parsed.data.name) data.name = parsed.data.name;
  if (parsed.data.permissions) Object.assign(data, permissionFields({ ...Object.fromEntries(PERMISSION_KEYS.map((k) => [k, existing[k]])), ...parsed.data.permissions }));

  const role = await prisma.role.update({ where: { id: existing.id }, data }).catch(() => null);
  if (!role) return res.status(400).json({ error: 'A role with that name already exists' });
  res.json({ id: role.id, name: role.name, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, role[k]])) });
});

masterDataRouter.delete('/roles/:id', requireRole('Admin'), async (req, res) => {
  const existing = await prisma.role.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  const inUse = await prisma.user.findFirst({ where: { role: existing.name } });
  if (inUse) return res.status(400).json({ error: 'Reassign every staff member off this role before deleting it' });
  await prisma.role.delete({ where: { id: existing.id } });
  res.status(204).end();
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

// Price/unit and the film/pressing-fee flags are all catalog definition
// properties — Admin-only, same access level as adding a service. Lets
// Admin reconfigure a service in place (e.g. switching DTF Printing from a
// flat per-piece price to a per-sqm rate) instead of needing a new service.
const serviceUpdateSchema = z
  .object({
    price: z.number().positive().optional(),
    unit: z.enum(['piece', 'metre', 'sqm']).optional(),
    tracksFilm: z.boolean().optional(),
    chargesPressingFee: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/services/:id', requireRole('Admin'), async (req, res) => {
  const parsed = serviceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const service = await prisma.service.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json(service);
});

// ── Artwork Size Bands (small DTF artwork flat-fee "quick picks") ───────
masterDataRouter.get('/artwork-size-bands', async (_req, res) => {
  res.json(await prisma.artworkSizeBand.findMany({ orderBy: { areaSqm: 'asc' } }));
});

const artworkSizeBandSchema = z.object({
  label: z.string().min(1),
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  price: z.number().positive(),
});

masterDataRouter.post('/artwork-size-bands', requireRole('Admin'), async (req, res) => {
  const parsed = artworkSizeBandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { label, lengthCm, widthCm, price } = parsed.data;
  const areaSqm = (lengthCm * widthCm) / 10000;
  res.status(201).json(await prisma.artworkSizeBand.create({ data: { label, lengthCm, widthCm, areaSqm, price } }));
});

const artworkSizeBandUpdateSchema = z
  .object({
    label: z.string().min(1).optional(),
    lengthCm: z.number().positive().optional(),
    widthCm: z.number().positive().optional(),
    price: z.number().positive().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

// areaSqm is never accepted directly — it's re-derived server-side from
// lengthCm x widthCm whenever either changes, so it can never drift out of
// sync with the dimensions that actually define the band.
masterDataRouter.put('/artwork-size-bands/:id', requireRole('Admin'), async (req, res) => {
  const parsed = artworkSizeBandUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const existing = await prisma.artworkSizeBand.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'Artwork size band not found' });

  const lengthCm = parsed.data.lengthCm ?? existing.lengthCm;
  const widthCm = parsed.data.widthCm ?? existing.widthCm;
  const areaSqm = (lengthCm * widthCm) / 10000;

  const band = await prisma.artworkSizeBand.update({
    where: { id: existing.id },
    data: { ...parsed.data, lengthCm, widthCm, areaSqm },
  });
  res.json(band);
});

masterDataRouter.delete('/artwork-size-bands/:id', requireRole('Admin'), async (req, res) => {
  await prisma.artworkSizeBand.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
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

masterDataRouter.put('/materials/:id', requirePermission('canApproveStock'), async (req, res) => {
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

const clientSchema = z.object({
  name: z.string().min(1),
  creditDays: z.number().int().positive(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
});

masterDataRouter.post('/corporate-clients', requireRole('Admin'), async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  res.status(201).json(await prisma.corporateClient.create({ data: { ...parsed.data, email: parsed.data.email ?? '', phone: parsed.data.phone ?? '' } }));
});

const clientUpdateSchema = z
  .object({
    creditDays: z.number().int().positive().optional(),
    email: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/corporate-clients/:id', requireRole('Admin'), async (req, res) => {
  const parsed = clientUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const client = await prisma.corporateClient.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!client) return res.status(404).json({ error: 'Corporate client not found' });
  res.json(client);
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
