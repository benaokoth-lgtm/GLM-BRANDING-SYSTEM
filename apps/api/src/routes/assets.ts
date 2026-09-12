import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { ASSET_CATEGORIES, ASSET_CONDITIONS } from '@glm/shared';

export const assetsRouter = Router();
assetsRouter.use(requireAuth, requirePermission('canAccessFinance'));

assetsRouter.get('/', async (req, res) => {
  const { category, condition } = req.query as { category?: string; condition?: string };
  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  if (condition) where.condition = condition;
  const assets = await prisma.asset.findMany({ where, orderBy: { name: 'asc' } });
  res.json(assets);
});

const assetSchema = z.object({
  tag: z.string().min(1, 'Asset tag is required'),
  name: z.string().min(1, 'Name is required'),
  category: z.enum(ASSET_CATEGORIES),
  quantity: z.number().int().positive().optional(),
  location: z.string().max(200).optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  value: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
});

assetsRouter.post('/', async (req, res) => {
  const parsed = assetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const asset = await prisma.asset
    .create({
      data: {
        tag: parsed.data.tag.trim(),
        name: parsed.data.name.trim(),
        category: parsed.data.category,
        quantity: parsed.data.quantity ?? 1,
        location: parsed.data.location ?? '',
        purchaseDate: parsed.data.purchaseDate ?? null,
        value: parsed.data.value ?? null,
        notes: parsed.data.notes ?? '',
        createdByName: req.user!.name,
      },
    })
    .catch(() => null);
  if (!asset) return res.status(400).json({ error: 'An asset with that tag already exists' });
  res.status(201).json(asset);
});

// Condition changes only via /:id/condition below — same reasoning as the
// Olerai Hotel System's asset register: centralizes the same-value guard in
// one place rather than duplicating it inside this general-purpose edit.
const assetUpdateSchema = z
  .object({
    tag: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
    quantity: z.number().int().positive().optional(),
    location: z.string().max(200).optional(),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    value: z.number().min(0).nullable().optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

assetsRouter.put('/:id', async (req, res) => {
  const parsed = assetUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = { ...parsed.data };
  if (data.tag) data.tag = data.tag.trim();
  if (data.name) data.name = data.name.trim();
  const asset = await prisma.asset.update({ where: { id: Number(req.params.id) }, data }).catch(() => null);
  if (!asset) return res.status(404).json({ error: 'Asset not found (or that tag is already in use)' });
  res.json(asset);
});

// Direct, no-approval condition change — routine record-keeping (marking
// something under repair, back in service, or retired), not a spend
// decision, so unlike Purchases/Stock Requisition there's no
// requester/approver split here.
assetsRouter.post('/:id/condition', async (req, res) => {
  const { condition } = req.body as { condition?: string };
  if (!condition || !ASSET_CONDITIONS.includes(condition as (typeof ASSET_CONDITIONS)[number])) {
    return res.status(400).json({ error: `Condition must be one of: ${ASSET_CONDITIONS.join(', ')}` });
  }
  const asset = await prisma.asset.findUnique({ where: { id: Number(req.params.id) } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.condition === condition) return res.status(400).json({ error: `Asset is already ${condition}` });

  const updated = await prisma.asset.update({ where: { id: asset.id }, data: { condition } });
  res.json(updated);
});

// Deleting an asset record entirely (as opposed to retiring it, which
// keeps history) is Admin-only, same level as Master Data's other
// destructive catalog actions.
assetsRouter.delete('/:id', requireRole('Admin'), async (req, res) => {
  await prisma.asset.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
