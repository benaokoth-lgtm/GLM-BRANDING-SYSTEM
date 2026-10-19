// KRA eTIMS — phase 1, the mapping only: which KRA item code, units and item type every business head, service and stock item is sold under. Nothing is sent to
// KRA here. A line uses its own code if it has one, else its business head's; a line is READY when it ends up with a code and a quantity unit. Every sale is VAT type B
// (16%). The proposals below are drafts for the accountant to check against the KRA portal's item-class search: only codes with some evidence behind them are proposed,
// everything else carries the words to search for instead.
import { prisma } from './db';

export const ETIMS_TAX_TYPE = 'B'; // 16% standard rate — every item GLM sells
export const ITEM_TYPES = ['service', 'finished', 'raw'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type EtimsKind = 'head' | 'service' | 'material';

/** KRA's item classification codes are UNSPSC-based: 8 digits, which KRA's own list may extend to 10. */
export const CODE_PATTERN = /^\d{8,10}$/;

export interface EtimsFields {
  clsCd: string;
  qtyUnit: string;
  pkgUnit: string;
  itemType: string;
  hsCode: string;
}
export const BLANK: EtimsFields = { clsCd: '', qtyUnit: '', pkgUnit: '', itemType: '', hsCode: '' };

export function cleanFields(input: Partial<EtimsFields>): { ok: true; fields: EtimsFields } | { ok: false; error: string } {
  const f: EtimsFields = {
    clsCd: (input.clsCd ?? '').replace(/\s+/g, ''),
    qtyUnit: (input.qtyUnit ?? '').trim().toUpperCase(),
    pkgUnit: (input.pkgUnit ?? '').trim().toUpperCase(),
    itemType: (input.itemType ?? '').trim().toLowerCase(),
    hsCode: (input.hsCode ?? '').replace(/[\s.]/g, ''),
  };
  if (f.clsCd && !CODE_PATTERN.test(f.clsCd)) return { ok: false, error: 'The item class code is 8 to 10 digits (KRA’s classification code — see the code list in the eTIMS portal)' };
  if (f.itemType && !(ITEM_TYPES as readonly string[]).includes(f.itemType)) return { ok: false, error: 'Item type must be service, finished (a product sold as it is made or bought) or raw (a material)' };
  if (f.hsCode && !/^\d{4,12}$/.test(f.hsCode)) return { ok: false, error: 'An HS code is 4 to 12 digits' };
  if (f.qtyUnit.length > 8 || f.pkgUnit.length > 8) return { ok: false, error: 'A unit code is a short code, not a name' };
  return { ok: true, fields: f };
}

export interface Resolved extends EtimsFields {
  from: 'item' | 'head' | null;
}

/** What a line is sold under: its own values, filling any gaps from its business head's. */
export function resolve(kind: EtimsKind, own: EtimsFields | undefined, head: EtimsFields | undefined): Resolved {
  const o = own ?? BLANK;
  const h = head ?? BLANK;
  const clsCd = o.clsCd || h.clsCd;
  return {
    clsCd,
    qtyUnit: o.qtyUnit || h.qtyUnit,
    pkgUnit: o.pkgUnit || h.pkgUnit,
    itemType: o.itemType || h.itemType || (kind === 'service' ? 'service' : kind === 'material' ? 'finished' : ''),
    hsCode: o.hsCode || h.hsCode,
    from: o.clsCd ? 'item' : h.clsCd ? 'head' : null,
  };
}

export const isReady = (r: EtimsFields): boolean => CODE_PATTERN.test(r.clsCd) && !!r.qtyUnit;

/** The unit a price-list unit is sold under on eTIMS. These are the codes we expect; they are checked against KRA's own unit list when we connect (phase 2). */
export function proposedUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (['piece', 'pcs', 'pc', 'item', 'each', 'unit'].includes(u)) return 'U';
  if (['metre', 'meter', 'm'].includes(u)) return 'M';
  if (u === 'sqm') return 'M2';
  return '';
}

// ── The proposed code list ───────────────────────────────────────────────────
// A draft only. 82121503 (digital printing) and 82121510 (textile printing) are the two UNSPSC commodity codes found for work we do; for the rest no code is proposed and
// the words to type into the KRA portal's item-class search are given instead. KRA's own list is what counts: the accountant confirms each against it.
export interface Proposal {
  clsCd: string;
  /** what to type into the KRA portal's item-class search */
  search: string;
}

const DIGITAL_PRINT = { clsCd: '82121503', search: 'digital printing' };
const TEXTILE_PRINT = { clsCd: '82121510', search: 'textile printing' };

/** The suggestion for a business head (the default its lines use). */
export function proposalForHead(headName: string): Proposal {
  const n = headName.trim().toLowerCase();
  if (n === 'dtf printing') return TEXTILE_PRINT;
  if (['uv printing', 'uv dtf printing', 'large format printing', 'printing & publications'].includes(n)) return DIGITAL_PRINT;
  if (n === 'laser engraving') return { clsCd: '', search: 'engraving services' };
  if (n === 'embroidery') return { clsCd: '', search: 'embroidery' };
  return { clsCd: '', search: '' };
}

/** What to search the KRA portal for, for one line — shown while it has no code. */
export function searchFor(kind: EtimsKind, name: string, headName: string): string {
  const n = name.toLowerCase();
  // goods are searched by what they are; a service is searched by the work (a mug that is engraved is still engraving)
  if (kind === 'material') {
    if (/t-?shirt/.test(n)) return 'T-shirts';
    if (/polo/.test(n)) return 'polo shirts';
    if (/hoodie/.test(n)) return 'hooded sweatshirts';
    if (/\bcap\b/.test(n)) return 'caps (headwear)';
    if (/mug/.test(n)) return 'mugs';
    if (/plaque/.test(n)) return 'plaques / awards';
    if (/led/.test(n)) return 'LED strip lighting';
    if (/thread/.test(n)) return 'embroidery thread';
    if (/film/.test(n)) return 'transfer film';
    if (/phone/.test(n)) return 'mobile phone accessories';
  }
  if (/digitiz|origination/.test(n)) return 'graphic design services';
  const p = proposalForHead(headName).search;
  return p || (kind === 'service' ? 'printing services' : '');
}

export interface Line {
  kind: 'service' | 'material';
  id: number;
  name: string;
  headId: number | null;
  head: string;
  unit: string;
  price: number;
}

/** Every line the price lists sell (retired services left out), with its business head. */
export async function sellableLines(): Promise<Line[]> {
  const [services, materials] = await Promise.all([
    prisma.service.findMany({ where: { retired: false }, include: { businessHead: true }, orderBy: { name: 'asc' } }),
    prisma.material.findMany({ include: { businessHead: true }, orderBy: { name: 'asc' } }),
  ]);
  return [
    ...services.map((s) => ({ kind: 'service' as const, id: s.id, name: s.name, headId: s.businessHeadId, head: s.businessHead?.name ?? '', unit: s.unit, price: s.price })),
    ...materials.map((m) => ({ kind: 'material' as const, id: m.id, name: m.name, headId: m.businessHeadId, head: m.businessHead?.name ?? '', unit: m.unit, price: m.price })),
  ];
}

/** What a service or stock item is sold under on eTIMS (used by phase 2 when an invoice is built). Null when it is not ready. */
export async function etimsFor(kind: 'service' | 'material', id: number): Promise<Resolved | null> {
  const row = kind === 'service' ? await prisma.service.findUnique({ where: { id }, select: { businessHeadId: true } }) : await prisma.material.findUnique({ where: { id }, select: { businessHeadId: true } });
  if (!row) return null;
  const items = await prisma.etimsItem.findMany({ where: { OR: [{ kind, refId: id }, ...(row.businessHeadId ? [{ kind: 'head', refId: row.businessHeadId }] : [])] } });
  const own = items.find((i) => i.kind === kind);
  const head = items.find((i) => i.kind === 'head');
  const r = resolve(kind, own, head);
  return isReady(r) ? r : null;
}
