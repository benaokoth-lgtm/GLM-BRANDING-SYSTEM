// The service and stock price lists as Excel files: download, edit in Excel, upload again.
// Lines are matched on Item (Service) + Size: a match is updated, anything new is added, nothing is ever deleted by an upload.
// An upload is first checked (?dryRun=1) so the Admin sees what it would do before it does it.
import express, { Router } from 'express';
import { materialName, defaultBusinessHeadName } from '@glm/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ensureMaterialItemsOnce } from '../materials';
import { ensureBusinessHeadsOnce } from '../purchases';
import { readXlsx, writeXlsx, type Cell } from '../xlsx';

export const pricelistsRouter = Router();
pricelistsRouter.use(requireAuth);

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 3000;
const SERVICE_UNITS = ['piece', 'metre', 'sqm'];

const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

function send(res: express.Response, filename: string, sheet: string, rows: Cell[][], widths: number[]) {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(writeXlsx(sheet, rows, widths));
}

// ── Download ─────────────────────────────────────────────────────────────────
pricelistsRouter.get('/services.xlsx', async (_req, res) => {
  await ensureMaterialItemsOnce();
  const services = await prisma.service.findMany({ where: { retired: false }, include: { businessHead: true }, orderBy: { name: 'asc' } });
  const rows: Cell[][] = [['Service', 'Description', 'Size', 'Unit', 'Price', 'Business head']];
  for (const s of services) rows.push([s.item || s.name, s.description, s.size, s.unit, s.price, s.businessHead?.name ?? '']);
  send(res, 'service-price-list.xlsx', 'Service price list', rows, [34, 36, 12, 10, 12, 26]);
});

pricelistsRouter.get('/materials.xlsx', async (_req, res) => {
  await ensureMaterialItemsOnce();
  const materials = await prisma.material.findMany({ include: { businessHead: true }, orderBy: { name: 'asc' } });
  const rows: Cell[][] = [['Item', 'Description', 'Size', 'Unit', 'Price', 'Business head', 'Reorder level', 'Stock on hand (not uploaded)']];
  for (const m of materials) rows.push([m.item || m.name, m.description, m.size, m.unit, m.price, m.businessHead?.name ?? '', m.reorderLevel, m.stockQty]);
  send(res, 'stock-price-list.xlsx', 'Stock price list', rows, [34, 36, 12, 10, 12, 26, 14, 24]);
});

// ── Reading the sheet ────────────────────────────────────────────────────────
interface SheetRow {
  line: number; // the row number in Excel
  get: (header: string) => string | undefined; // undefined = no such column
}

/** Finds the header row (the first row that has the item column and a Price column) and returns the data rows under it. */
function sheetRows(grid: string[][], itemHeaders: string[]): { rows: SheetRow[]; has: (h: string) => boolean } {
  const norm = (s: string) => s.trim().toLowerCase();
  const headerIndex = grid.findIndex((r) => r && r.some((c) => itemHeaders.includes(norm(c))) && r.some((c) => norm(c) === 'price'));
  if (headerIndex < 0) throw new Error(`The first sheet needs a header row with the columns ${itemHeaders[0]![0]!.toUpperCase()}${itemHeaders[0]!.slice(1)} and Price — download the list to see the layout`);
  const header = grid[headerIndex]!.map(norm);
  const col = (h: string) => (h === 'item' ? header.findIndex((x) => itemHeaders.includes(x)) : header.indexOf(h));
  const rows: SheetRow[] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    if (!r.some((c) => c && c.trim())) continue;
    rows.push({ line: i + 1, get: (h) => (col(h) < 0 ? undefined : (r[col(h)] ?? '').trim()) });
  }
  return { rows, has: (h) => col(h) >= 0 };
}

const money = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.replace(/[, ]/g, '').replace(/^ksh/i, ''));
  return Number.isFinite(n) ? n : NaN;
};

interface Result {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: { row: number; message: string }[];
}

const rawBody = express.raw({ type: () => true, limit: '10mb' });

function parseGrid(req: express.Request): string[][] {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new Error('Choose an Excel (.xlsx) file to upload');
  const grid = readXlsx(req.body);
  if (grid.length > MAX_ROWS + 5) throw new Error(`The file has more than ${MAX_ROWS} rows`);
  return grid;
}

// ── Upload: services ─────────────────────────────────────────────────────────
pricelistsRouter.post('/services', requireRole('Admin'), rawBody, async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  let sheet;
  try {
    sheet = sheetRows(parseGrid(req), ['service', 'item', 'name']);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'That file could not be read' });
  }
  await ensureMaterialItemsOnce();
  await ensureBusinessHeadsOnce();
  const heads = await prisma.businessHead.findMany();
  const existing = await prisma.service.findMany({ where: { retired: false } });
  const seen = new Set<string>();
  const result: Result = { dryRun, total: sheet.rows.length, created: 0, updated: 0, unchanged: 0, errors: [] };
  const ops: (() => Prisma.PrismaPromise<unknown>)[] = [];

  for (const row of sheet.rows) {
    const item = clean(row.get('item') ?? '');
    const size = clean(row.get('size') ?? '');
    const fail = (message: string) => result.errors.push({ row: row.line, message });
    if (!item) { fail('The service name is blank'); continue; }
    const fullName = materialName(item, size);
    if (seen.has(fullName.toLowerCase())) { fail(`${fullName} appears twice in the file`); continue; }
    seen.add(fullName.toLowerCase());

    const priceText = row.get('price');
    const price = money(priceText);
    const unitText = (row.get('unit') ?? '').toLowerCase();
    if (unitText && !SERVICE_UNITS.includes(unitText)) { fail(`Unit must be ${SERVICE_UNITS.join(', ')} (not "${unitText}")`); continue; }
    const headName = row.get('business head') ?? '';
    const head = headName ? heads.find((h) => same(h.name, headName)) : undefined;
    if (headName && !head) { fail(`Business head "${headName}" does not exist`); continue; }
    const description = row.get('description');

    const current = existing.find((s) => same(s.name, fullName));
    if (current) {
      const data: Record<string, unknown> = {};
      if (priceText) {
        if (!(price! > 0)) { fail('The price must be a number greater than 0'); continue; }
        if (price !== current.price) data.price = price;
      }
      if (unitText && unitText !== current.unit) data.unit = unitText;
      if (description !== undefined && description !== current.description) data.description = description;
      if (head && head.id !== current.businessHeadId) data.businessHeadId = head.id;
      if (Object.keys(data).length === 0) { result.unchanged++; continue; }
      result.updated++;
      ops.push(() => prisma.service.update({ where: { id: current.id }, data }));
    } else {
      if (!(price! > 0)) { fail('A new service needs a price greater than 0'); continue; }
      const headId = head?.id ?? heads.find((h) => h.name === defaultBusinessHeadName(fullName))?.id ?? null;
      result.created++;
      ops.push(() => prisma.service.create({ data: { name: fullName, item, size, description: description ?? '', unit: unitText || 'piece', price: price!, businessHeadId: headId } }));
    }
  }
  if (!dryRun && ops.length) await prisma.$transaction(ops.map((op) => op()));
  res.json(result);
});

// ── Upload: stock ────────────────────────────────────────────────────────────
pricelistsRouter.post('/materials', requireRole('Admin'), rawBody, async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  let sheet;
  try {
    sheet = sheetRows(parseGrid(req), ['item', 'name', 'service']);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'That file could not be read' });
  }
  await ensureMaterialItemsOnce();
  const heads = await prisma.businessHead.findMany();
  const existing = await prisma.material.findMany();
  // What the list will hold as the rows are applied one by one, so a sheet is checked against itself as well.
  const lines = existing.map((m) => ({ id: m.id as number | null, item: m.item || m.name, size: m.size, price: m.price, unit: m.unit, description: m.description, reorderLevel: m.reorderLevel, businessHeadId: m.businessHeadId }));
  const seen = new Set<string>();
  const result: Result = { dryRun, total: sheet.rows.length, created: 0, updated: 0, unchanged: 0, errors: [] };
  const ops: (() => Prisma.PrismaPromise<unknown>)[] = [];

  for (const row of sheet.rows) {
    const item = clean(row.get('item') ?? '');
    const size = clean(row.get('size') ?? '');
    const fail = (message: string) => result.errors.push({ row: row.line, message });
    if (!item) { fail('The item name is blank'); continue; }
    const fullName = materialName(item, size);
    if (seen.has(fullName.toLowerCase())) { fail(`${fullName} appears twice in the file`); continue; }
    seen.add(fullName.toLowerCase());

    const priceText = row.get('price');
    const price = money(priceText);
    const unit = clean(row.get('unit') ?? '');
    const headName = row.get('business head') ?? '';
    const head = headName ? heads.find((h) => same(h.name, headName)) : undefined;
    if (headName && !head) { fail(`Business head "${headName}" does not exist`); continue; }
    const reorderText = row.get('reorder level');
    const reorder = reorderText ? money(reorderText) : null;
    if (reorderText && !(reorder! >= 0)) { fail('Reorder level must be a number, 0 or more'); continue; }
    const description = row.get('description');

    const current = lines.find((l) => same(l.item, item) && same(l.size, size));
    if (current) {
      const data: Record<string, unknown> = {};
      if (priceText) {
        if (!(price! > 0)) { fail('The price must be a number greater than 0'); continue; }
        if (price !== current.price) data.price = price;
      }
      if (unit && unit !== current.unit) data.unit = unit;
      if (description !== undefined && description !== current.description) data.description = description;
      if (head && head.id !== current.businessHeadId) data.businessHeadId = head.id;
      if (reorder !== null && reorder !== current.reorderLevel) data.reorderLevel = reorder;
      if (Object.keys(data).length === 0) { result.unchanged++; continue; }
      result.updated++;
      Object.assign(current, data);
      const id = current.id;
      ops.push(() => prisma.material.update({ where: { id: id! }, data }));
    } else {
      if (!(price! > 0)) { fail('A new item needs a price greater than 0'); continue; }
      const group = lines.filter((l) => same(l.item, item));
      if (group.some((l) => !l.size) && size) { fail(`${item} exists without a size — give that line a size first, then add the other sizes`); continue; }
      if (group.some((l) => l.size) && !size) { fail(`${item} comes in sizes — this line needs a size`); continue; }
      result.created++;
      lines.push({ id: null, item, size, price: price!, unit: unit || 'piece', description: description ?? '', reorderLevel: reorder ?? 0, businessHeadId: head?.id ?? null });
      ops.push(() => prisma.material.create({ data: { name: fullName, item, size, description: description ?? '', unit: unit || 'piece', price: price!, reorderLevel: reorder ?? 0, businessHeadId: head?.id ?? null } }));
    }
  }
  if (!dryRun && ops.length) await prisma.$transaction(ops.map((op) => op()));
  res.json(result);
});
