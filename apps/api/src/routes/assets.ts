import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { ASSET_CATEGORIES, ASSET_CONDITIONS, DEPRECIATION_METHODS, todayStr } from '@glm/shared';

// Funding the purchase of an asset: where the money came from, so the balance sheet balances.
export const ASSET_FUNDING = ['Bank', 'Cash', 'M-Pesa', 'Owner Capital', 'Opening Balance'] as const;

export const assetsRouter = Router();
assetsRouter.use(requireAuth, requirePermission('canAccessFinance'));

assetsRouter.get('/', async (req, res) => {
  const { category, condition } = req.query as { category?: string; condition?: string };
  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  if (condition) where.condition = condition;
  const assets = await prisma.asset.findMany({ where, orderBy: { name: 'asc' }, include: { depreciations: true } });
  res.json(
    assets.map(({ depreciations, ...a }) => {
      const accumulatedDepreciation = Math.round(depreciations.reduce((x, d) => x + d.amount, 0) * 100) / 100;
      return { ...a, accumulatedDepreciation, bookValue: a.value != null ? Math.round((a.value - accumulatedDepreciation) * 100) / 100 : null };
    }),
  );
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
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
  usefulLifeYears: z.number().positive().max(100).nullable().optional(),
  depreciationRatePct: z.number().positive().max(100).nullable().optional(),
  salvageValue: z.number().min(0).optional(),
  fundedBy: z.enum(ASSET_FUNDING).optional(),
});

// A method needs the figure it works from, and salvage can't exceed cost.
function depreciationProblem(d: { depreciationMethod?: string; usefulLifeYears?: number | null; depreciationRatePct?: number | null; salvageValue?: number; value?: number | null }): string | null {
  if (d.depreciationMethod === 'Straight-line' && !d.usefulLifeYears) return 'Straight-line depreciation needs a useful life (years)';
  if (d.depreciationMethod === 'Reducing balance' && !d.depreciationRatePct) return 'Reducing-balance depreciation needs an annual rate (%)';
  if ((d.depreciationMethod ?? 'None') !== 'None' && !(d.value && d.value > 0)) return "Depreciation needs the asset's cost (Value)";
  if (d.salvageValue && d.value != null && d.salvageValue > d.value) return 'Salvage value cannot be more than the cost';
  return null;
}

assetsRouter.post('/', async (req, res) => {
  const parsed = assetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const problem = depreciationProblem({ ...parsed.data, value: parsed.data.value ?? null });
  if (problem) return res.status(400).json({ error: problem });
  if ((parsed.data.depreciationMethod ?? 'None') !== 'None' && !parsed.data.purchaseDate) return res.status(400).json({ error: 'Depreciation needs a purchase date' });
  const asset = await prisma.asset
    .create({
      data: {
        depreciationMethod: parsed.data.depreciationMethod ?? 'None',
        usefulLifeYears: parsed.data.usefulLifeYears ?? null,
        depreciationRatePct: parsed.data.depreciationRatePct ?? null,
        salvageValue: parsed.data.salvageValue ?? 0,
        fundedBy: parsed.data.fundedBy ?? 'Owner Capital',
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
    depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
    usefulLifeYears: z.number().positive().max(100).nullable().optional(),
    depreciationRatePct: z.number().positive().max(100).nullable().optional(),
    salvageValue: z.number().min(0).optional(),
    fundedBy: z.enum(ASSET_FUNDING).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

assetsRouter.put('/:id', async (req, res) => {
  const parsed = assetUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = { ...parsed.data };
  if (data.tag) data.tag = data.tag.trim();
  if (data.name) data.name = data.name.trim();
  const current = await prisma.asset.findUnique({ where: { id: Number(req.params.id) } });
  if (!current) return res.status(404).json({ error: 'Asset not found' });
  const merged = { ...current, ...data };
  const problem = depreciationProblem({ depreciationMethod: merged.depreciationMethod, usefulLifeYears: merged.usefulLifeYears, depreciationRatePct: merged.depreciationRatePct, salvageValue: merged.salvageValue, value: merged.value });
  if (problem) return res.status(400).json({ error: problem });
  if (merged.depreciationMethod !== 'None' && !merged.purchaseDate) return res.status(400).json({ error: 'Depreciation needs a purchase date' });
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

  // Retiring an asset stops its depreciation from that month; bringing it back into service resumes it.
  const updated = await prisma.asset.update({ where: { id: asset.id }, data: { condition, retiredOn: condition === 'Retired' ? todayStr() : null } });
  res.json(updated);
});

// Deleting an asset record entirely (as opposed to retiring it, which
// keeps history) is Admin-only, same level as Master Data's other
// destructive catalog actions.
assetsRouter.delete('/:id', requireRole('Admin'), async (req, res) => {
  await prisma.asset.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
