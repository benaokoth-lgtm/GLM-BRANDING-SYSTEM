// KRA eTIMS, phase 1 — the mapping (Master Data → eTIMS Codes, Admin): the item class code, units and item type each business head, service and stock item is sold under.
// Nothing here talks to KRA. See ../etims.ts for how a line's code is worked out and what is proposed.
import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { readXlsx, writeXlsx, type Cell } from '../xlsx';
import { BLANK, ETIMS_TAX_TYPE, cleanFields, isReady, proposalForHead, proposedUnit, resolve, searchFor, sellableLines, type EtimsFields, type EtimsKind } from '../etims';

export const etimsRouter = Router();
etimsRouter.use(requireAuth, requireRole('Admin'));

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KIND_LABEL: Record<EtimsKind, string> = { head: 'Business head', service: 'Service', material: 'Stock item' };
const KIND_OF = (label: string): EtimsKind | null => {
  const l = label.trim().toLowerCase();
  if (l === 'business head' || l === 'head') return 'head';
  if (l === 'service') return 'service';
  if (l === 'stock item' || l === 'material' || l === 'stock') return 'material';
  return null;
};

type Stored = { kind: string; refId: number; clsCd: string; qtyUnit: string; pkgUnit: string; itemType: string; hsCode: string; status: string; confirmedByName: string; confirmedAt: Date | null };
const fieldsOf = (r: Stored | undefined): EtimsFields => (r ? { clsCd: r.clsCd, qtyUnit: r.qtyUnit, pkgUnit: r.pkgUnit, itemType: r.itemType, hsCode: r.hsCode } : BLANK);
const key = (kind: string, id: number) => `${kind}:${id}`;

type State = 'missing' | 'proposed' | 'confirmed';

async function build() {
  const [lines, heads, stored] = await Promise.all([sellableLines(), prisma.businessHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }), prisma.etimsItem.findMany()]);
  const by = new Map(stored.map((s) => [key(s.kind, s.refId), s]));

  const headRows = heads.map((h) => {
    const own = by.get(key('head', h.id));
    const p = proposalForHead(h.name);
    return { kind: 'head' as const, id: h.id, name: h.name, active: h.active, own: { ...fieldsOf(own), status: own?.status ?? '' }, proposal: p, lines: lines.filter((l) => l.headId === h.id).length };
  });

  const rows = lines.map((l) => {
    const own = by.get(key(l.kind, l.id));
    const headOwn = l.headId ? by.get(key('head', l.headId)) : undefined;
    const eff = resolve(l.kind, own ? fieldsOf(own) : undefined, headOwn ? fieldsOf(headOwn) : undefined);
    const ready = isReady(eff);
    // confirmed only when whatever the code comes from has been confirmed
    const source = eff.from === 'item' ? own : eff.from === 'head' ? headOwn : undefined;
    const state: State = !ready ? 'missing' : source?.status === 'confirmed' ? 'confirmed' : 'proposed';
    return {
      kind: l.kind,
      id: l.id,
      name: l.name,
      head: l.head,
      headId: l.headId,
      unit: l.unit,
      price: l.price,
      own: { ...fieldsOf(own), status: own?.status ?? '' },
      eff,
      ready,
      state,
      search: ready ? '' : searchFor(l.kind, l.name, l.head),
    };
  });
  const count = (s: State) => rows.filter((r) => r.state === s).length;
  return { taxType: ETIMS_TAX_TYPE, heads: headRows, items: rows, counts: { total: rows.length, ready: rows.filter((r) => r.ready).length, missing: count('missing'), proposed: count('proposed'), confirmed: count('confirmed') } };
}

etimsRouter.get('/overview', async (_req, res) => {
  res.json(await build());
});

// ── One head, service or stock item ──────────────────────────────────────────
const itemSchema = z.object({
  kind: z.enum(['head', 'service', 'material']),
  refId: z.number().int().positive(),
  clsCd: z.string().max(20).optional(),
  qtyUnit: z.string().max(20).optional(),
  pkgUnit: z.string().max(20).optional(),
  itemType: z.string().max(20).optional(),
  hsCode: z.string().max(20).optional(),
});

async function exists(kind: EtimsKind, id: number): Promise<boolean> {
  if (kind === 'head') return !!(await prisma.businessHead.findUnique({ where: { id } }));
  if (kind === 'service') return !!(await prisma.service.findUnique({ where: { id } }));
  return !!(await prisma.material.findUnique({ where: { id } }));
}

// Saving by hand is a deliberate act, so it counts as confirmed (blank everything = go back to using the business head's).
etimsRouter.put('/item', async (req, res) => {
  const body = itemSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
  const { kind, refId, ...rest } = body.data;
  const cleaned = cleanFields(rest);
  if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
  if (!(await exists(kind, refId))) return res.status(404).json({ error: 'That line no longer exists' });
  const f = cleaned.fields;
  if (!f.clsCd && !f.qtyUnit && !f.pkgUnit && !f.itemType && !f.hsCode) {
    await prisma.etimsItem.deleteMany({ where: { kind, refId } });
    return res.json({ ok: true, cleared: true });
  }
  const data = { ...f, status: 'confirmed', confirmedByName: req.user!.name, confirmedAt: new Date() };
  await prisma.etimsItem.upsert({ where: { kind_refId: { kind, refId } }, create: { kind, refId, ...data }, update: data });
  res.json({ ok: true });
});

// ── The proposed list ────────────────────────────────────────────────────────
// Fills in what is empty and never overwrites anything already there: a business head's suggested code, and each line's unit and item type.
etimsRouter.post('/propose', async (_req, res) => {
  const [lines, heads, stored] = await Promise.all([sellableLines(), prisma.businessHead.findMany(), prisma.etimsItem.findMany()]);
  const by = new Map(stored.map((s) => [key(s.kind, s.refId), s]));
  let created = 0;
  let filled = 0;
  for (const h of heads) {
    const p = proposalForHead(h.name);
    if (!p.clsCd) continue;
    const cur = by.get(key('head', h.id));
    if (cur?.clsCd) continue;
    if (cur) {
      await prisma.etimsItem.update({ where: { id: cur.id }, data: { clsCd: p.clsCd, status: 'proposed', confirmedByName: '', confirmedAt: null } });
      filled++;
    } else {
      await prisma.etimsItem.create({ data: { kind: 'head', refId: h.id, clsCd: p.clsCd, status: 'proposed' } });
      created++;
    }
  }
  for (const l of lines) {
    const cur = by.get(key(l.kind, l.id));
    const unit = proposedUnit(l.unit);
    const type = l.kind === 'service' ? 'service' : 'finished';
    if (cur) {
      const data: Record<string, string> = {};
      if (!cur.qtyUnit && unit) data.qtyUnit = unit;
      if (!cur.itemType) data.itemType = type;
      if (Object.keys(data).length) {
        await prisma.etimsItem.update({ where: { id: cur.id }, data });
        filled++;
      }
    } else {
      await prisma.etimsItem.create({ data: { kind: l.kind, refId: l.id, qtyUnit: unit, itemType: type, status: 'proposed' } });
      created++;
    }
  }
  res.json({ created, filled, ...(await build()).counts });
});

// Confirms what has been checked against the KRA portal: every proposed row that has a code — or those of one business head and its lines.
etimsRouter.post('/confirm', async (req, res) => {
  const body = z.object({ headId: z.number().int().positive().optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'Invalid input' });
  const headId = body.data.headId;
  const where: Record<string, unknown> = { status: 'proposed', clsCd: { not: '' } };
  if (headId) {
    const [svc, mat] = await Promise.all([prisma.service.findMany({ where: { businessHeadId: headId }, select: { id: true } }), prisma.material.findMany({ where: { businessHeadId: headId }, select: { id: true } })]);
    where.OR = [{ kind: 'head', refId: headId }, { kind: 'service', refId: { in: svc.map((s) => s.id) } }, { kind: 'material', refId: { in: mat.map((m) => m.id) } }];
  }
  const r = await prisma.etimsItem.updateMany({ where: where as never, data: { status: 'confirmed', confirmedByName: req.user!.name, confirmedAt: new Date() } });
  res.json({ confirmed: r.count });
});

// ── Excel: download, fill in the codes, upload ───────────────────────────────
const HEADERS = ['Kind', 'Id', 'Name', 'Business head', 'Unit', 'Price (VAT included)', 'KRA item class code', 'Quantity unit', 'Packaging unit', 'Item type (service / finished / raw)', 'HS code (imports only)', 'Status (Confirmed / Proposed)', 'Code in use (not uploaded)', 'Search the KRA portal for (not uploaded)'];

etimsRouter.get('/mapping.xlsx', async (_req, res) => {
  const s = await build();
  const out: Cell[][] = [HEADERS];
  for (const h of s.heads) {
    out.push([KIND_LABEL.head, h.id, h.name, '', '', null, h.own.clsCd, h.own.qtyUnit, h.own.pkgUnit, h.own.itemType, h.own.hsCode, h.own.status ? (h.own.status === 'confirmed' ? 'Confirmed' : 'Proposed') : '', h.own.clsCd, h.proposal.search]);
  }
  for (const i of s.items) {
    out.push([KIND_LABEL[i.kind], i.id, i.name, i.head, i.unit, i.price, i.own.clsCd, i.own.qtyUnit, i.own.pkgUnit, i.own.itemType, i.own.hsCode, i.own.status ? (i.own.status === 'confirmed' ? 'Confirmed' : 'Proposed') : '', i.eff.clsCd ? `${i.eff.clsCd}${i.eff.from === 'head' ? ' (business head)' : ''}` : '', i.search]);
  }
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', 'attachment; filename="etims-item-codes.xlsx"');
  res.send(writeXlsx('eTIMS codes', out, [14, 7, 36, 24, 9, 14, 20, 12, 12, 20, 16, 16, 24, 30]));
});

interface Result {
  dryRun: boolean;
  total: number;
  updated: number;
  unchanged: number;
  errors: { row: number; message: string }[];
}

const rawBody = express.raw({ type: () => true, limit: '10mb' });

// A row is matched on Kind + Id (leave those two columns alone); only the code, unit, type, HS code and status columns are read. A row whose Status says Confirmed is
// confirmed, any other is kept as proposed; blank code and unit columns on a line mean "use the business head's".
etimsRouter.post('/mapping', rawBody, async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Choose an Excel (.xlsx) file to upload' });
  let grid: string[][];
  try {
    grid = readXlsx(req.body);
  } catch {
    return res.status(400).json({ error: 'That file could not be read' });
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const headIdx = grid.findIndex((r) => r.some((c) => norm(c) === 'kind') && r.some((c) => norm(c) === 'id'));
  if (headIdx < 0) return res.status(400).json({ error: 'The first row must have the Kind and Id columns, as in the downloaded sheet' });
  const header = grid[headIdx]!.map(norm);
  const col = (startsWith: string) => header.findIndex((h) => h.startsWith(startsWith));
  const c = { kind: col('kind'), id: col('id'), cls: col('kra item class'), qty: col('quantity unit'), pkg: col('packaging unit'), type: col('item type'), hs: col('hs code'), status: col('status') };
  if (c.cls < 0) return res.status(400).json({ error: 'There is no “KRA item class code” column' });

  const stored = await prisma.etimsItem.findMany();
  const by = new Map(stored.map((s) => [key(s.kind, s.refId), s]));
  const result: Result = { dryRun, total: 0, updated: 0, unchanged: 0, errors: [] };
  const ops: (() => Promise<unknown>)[] = [];

  for (let r = headIdx + 1; r < grid.length; r++) {
    const row = grid[r]!;
    if (row.every((x) => !x?.trim())) continue;
    result.total++;
    const line = r + 1;
    const fail = (message: string) => result.errors.push({ row: line, message });
    const kind = KIND_OF(row[c.kind] ?? '');
    const refId = Number((row[c.id] ?? '').trim());
    if (!kind || !Number.isInteger(refId) || refId <= 0) { fail('Kind and Id must be as in the downloaded sheet'); continue; }
    if (!(await exists(kind, refId))) { fail(`${KIND_LABEL[kind]} ${refId} does not exist`); continue; }
    const cleaned = cleanFields({ clsCd: row[c.cls], qtyUnit: c.qty >= 0 ? row[c.qty] : '', pkgUnit: c.pkg >= 0 ? row[c.pkg] : '', itemType: c.type >= 0 ? row[c.type] : '', hsCode: c.hs >= 0 ? row[c.hs] : '' });
    if (!cleaned.ok) { fail(cleaned.error); continue; }
    const f = cleaned.fields;
    const statusText = c.status >= 0 ? norm(row[c.status] ?? '') : '';
    const status = statusText === 'confirmed' ? 'confirmed' : 'proposed';
    const cur = by.get(key(kind, refId));
    const empty = !f.clsCd && !f.qtyUnit && !f.pkgUnit && !f.itemType && !f.hsCode;
    if (empty) {
      if (cur) { result.updated++; ops.push(() => prisma.etimsItem.deleteMany({ where: { kind, refId } })); } else result.unchanged++;
      continue;
    }
    const same = cur && cur.clsCd === f.clsCd && cur.qtyUnit === f.qtyUnit && cur.pkgUnit === f.pkgUnit && cur.itemType === f.itemType && cur.hsCode === f.hsCode && cur.status === status;
    if (same) { result.unchanged++; continue; }
    result.updated++;
    const data = { ...f, status, confirmedByName: status === 'confirmed' ? req.user!.name : '', confirmedAt: status === 'confirmed' ? new Date() : null };
    ops.push(() => prisma.etimsItem.upsert({ where: { kind_refId: { kind, refId } }, create: { kind, refId, ...data }, update: data }));
  }
  if (!dryRun && result.errors.length === 0) for (const op of ops) await op();
  else if (!dryRun) return res.status(400).json({ ...result, error: 'Nothing was saved: fix the rows listed and upload again' });
  res.json(result);
});
