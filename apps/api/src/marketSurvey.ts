import { prisma } from './db';
import { ensureMaterialItemsOnce } from './materials';
import { printSettings } from './routes/costing';
import type { Cell } from './xlsx';

// The market-survey sheet: everything GLM sells, and the jobs it should know the market price of, WITHOUT our prices — so the people doing the survey are not influenced by them and the
// sheet can be shared. One row per thing to price, with the exact specification to ask each competitor for and empty columns to write their prices in.
//   · the service price list and the stock (item / material) price list, as they are in the system;
//   · what the system prices by a formula rather than from a list: DTF and UV DTF film and artwork, UV pens, embroidery, business cards, signage, eulogies, company profiles, brochures.

export const SURVEY_HEADERS = ['No.', 'Category', 'Item / service', 'Description', 'Size', 'Unit', 'Compare on (ask each competitor for exactly this)', 'Business head', 'Competitor 1 price', 'Competitor 2 price', 'Competitor 3 price', 'Competitor 4 price', 'Competitor 5 price', 'Notes (shop, date, VAT included?)'];
export const SURVEY_WIDTHS = [6, 20, 36, 34, 12, 12, 58, 22, 16, 16, 16, 16, 16, 34];

interface Row {
  category: string;
  item: string;
  description?: string;
  size?: string;
  unit: string;
  compare: string;
  head?: string;
}

const UNIT_WORD: Record<string, string> = { piece: 'piece', metre: 'metre', sqm: 'sqm' };
const num = (n: number) => n.toLocaleString('en-US');

export async function marketSurveyRows(): Promise<Cell[][]> {
  await ensureMaterialItemsOnce();
  const [services, materials, penTiers, print] = await Promise.all([
    prisma.service.findMany({ where: { retired: false }, include: { businessHead: true }, orderBy: [{ item: 'asc' }, { name: 'asc' }] }),
    prisma.material.findMany({ include: { businessHead: true }, orderBy: [{ item: 'asc' }, { name: 'asc' }] }),
    prisma.penTier.findMany({ orderBy: { fromQty: 'asc' } }),
    printSettings(),
  ]);
  const rows: Row[] = [];

  // ── the service price list (the ones sold through their own screens are further down, spelled out)
  for (const s of services) {
    if (s.soldViaDtfModule) continue;
    const unit = UNIT_WORD[s.unit] ?? s.unit;
    rows.push({
      category: 'Services',
      item: s.item || s.name,
      description: s.description,
      size: s.size,
      unit,
      compare: s.usesArtworkPricing ? `Price per sqm of artwork (state the artwork size you priced), VAT stated` : `Price for one ${unit}, supplied and finished, VAT stated`,
      head: s.businessHead?.name ?? '',
    });
  }

  // ── the stock price list
  for (const m of materials) {
    const unit = UNIT_WORD[m.unit] ?? m.unit;
    rows.push({ category: 'Stock items', item: m.item || m.name, description: m.description, size: m.size, unit, compare: `Shelf price of one ${unit}, same make and size, VAT stated`, head: m.businessHead?.name ?? '' });
  }

  // ── DTF and UV DTF
  const dtf = 'DTF Printing';
  const uv = 'UV DTF Printing';
  rows.push({ category: 'DTF & UV DTF', item: 'DTF film sale (transfer film, no artwork)', unit: 'metre', compare: 'Price per metre of DTF transfer film printed with the customer’s own gang sheet (state the roll width)', head: dtf });
  for (const size of ['A4', 'A3']) rows.push({ category: 'DTF & UV DTF', item: `DTF print, one ${size} transfer`, size, unit: 'piece', compare: `Price of one ${size} DTF transfer, full colour, printed only (not pressed)`, head: dtf });
  rows.push({ category: 'DTF & UV DTF', item: 'DTF print, small logo (about 10 cm)', size: '10 cm', unit: 'piece', compare: 'Price of one 10 cm DTF logo transfer, ordered in 50 pieces', head: dtf });
  rows.push({ category: 'DTF & UV DTF', item: 'Heat-press application of a transfer', unit: 'piece', compare: 'Price to press one transfer onto a garment you are given', head: dtf });
  rows.push({ category: 'DTF & UV DTF', item: 'UV DTF film sale (30 cm roll)', unit: 'metre', compare: 'Price per metre of UV DTF film printed with the customer’s own artwork (state the roll width)', head: uv });
  for (const size of ['5 cm', '10 cm', 'A5']) rows.push({ category: 'DTF & UV DTF', item: `UV DTF sticker / transfer, ${size}`, size, unit: 'piece', compare: `Price of one ${size} UV DTF transfer ordered in 100 pieces`, head: uv });

  // ── UV pens (the quantities where our price changes, and the usual ones)
  const penQtys = [...new Set([1, 10, 50, 100, 250, 500, 1000, 1500, ...penTiers.map((t) => t.fromQty)])].sort((a, b) => a - b);
  for (const q of penQtys) rows.push({ category: 'UV pens', item: `UV-printed pen, ${num(q)} pen${q === 1 ? '' : 's'}`, unit: 'piece', compare: `Price per pen for an order of ${num(q)}, plain pen with a one-colour UV print (state the pen model)`, head: 'UV Printing' });

  // ── embroidery (priced by stitches)
  for (const [stitches, qty] of [[5000, 1], [5000, 12], [5000, 50], [5000, 100], [10000, 12], [10000, 50]] as const) {
    rows.push({ category: 'Embroidery', item: `Embroidery, ${num(stitches)}-stitch logo, ${qty} piece${qty === 1 ? '' : 's'}`, unit: 'piece', compare: `Price per piece to embroider a ${num(stitches)}-stitch logo on garments supplied, order of ${qty}; say what setup fee applies`, head: 'Embroidery' });
  }
  rows.push({ category: 'Embroidery', item: 'Embroidery digitizing (a new logo)', unit: 'job', compare: 'One-off fee to digitize a new logo (and whether it is waived on a larger order)', head: 'Embroidery' });

  // ── business cards (the printer's A3 sheet pricing)
  for (const finish of ['Plain', 'Laminated', 'Frosted']) {
    for (const q of [100, 250, 500, 1000]) rows.push({ category: 'Business cards', item: `Business cards, ${finish.toLowerCase()}, ${num(q)}`, unit: 'set', compare: `Price for ${num(q)} cards, ${finish.toLowerCase()}, both sides, standard 90 × 55 mm, artwork supplied`, head: 'General Order' });
  }

  // ── signage
  rows.push({ category: 'Signage', item: 'Indoor signage, 1 m × 2 m', size: '1 × 2 m', unit: 'sqm', compare: 'Price of one indoor sign 1 m × 2 m (vinyl on board, laminated) — and the price per sqm', head: 'Large Format Printing' });
  rows.push({ category: 'Signage', item: 'Indoor signage, 3 m²', size: '3 sqm', unit: 'sqm', compare: 'Price per sqm for a 3 sqm indoor sign (state the material)', head: 'Large Format Printing' });
  rows.push({ category: 'Signage', item: 'Outdoor signage, 3 m × 1 m', size: '3 × 1 m', unit: 'sqm', compare: 'Price of one outdoor sign 3 m × 1 m (banner / ACP, UV laminated) — and the price per sqm', head: 'Large Format Printing' });
  rows.push({ category: 'Signage', item: 'Outdoor signage with frame and mounting', unit: 'sqm', compare: 'Price per sqm for an outdoor sign with frame / structure and mounting, up to 3 sqm', head: 'Large Format Printing' });

  // ── eulogies, company profiles, brochures (the printer's standard paper, the same specifications as our price list)
  const paper = print.papers[0]?.name ?? '130gsm gloss';
  for (const pages of [4, 8, 16, 24, 32]) {
    for (const q of [50, 100, 500]) rows.push({ category: 'Eulogies', item: `Eulogy booklet, ${pages} pages, ${q} copies`, unit: 'copy', compare: `Price per copy: ${pages}-page A4 booklet, ${paper} inside, stapled and trimmed, ${q} copies, design not included`, head: 'General Order' });
  }
  for (const pages of [8, 16, 32]) {
    for (const q of [50, 100]) rows.push({ category: 'Company profiles', item: `Company profile, ${pages} pages, ${q} copies`, unit: 'copy', compare: `Price per copy: ${pages}-page A4 profile, ${paper} inside, stapled and trimmed, ${q} copies, design not included`, head: 'General Order' });
  }
  for (const size of ['A4', 'B5']) {
    for (const sides of ['single', 'double']) {
      for (const q of [100, 500, 1000]) rows.push({ category: 'Brochures', item: `Brochure, ${size}, ${sides} side, ${num(q)}`, unit: 'piece', compare: `Price per piece: ${size} ${sides}-sided flyer / brochure, ${paper}, ${num(q)} pieces`, head: 'General Order' });
    }
  }

  const out: Cell[][] = [SURVEY_HEADERS];
  rows.forEach((r, i) => out.push([i + 1, r.category, r.item, r.description ?? '', r.size ?? '', r.unit, r.compare, r.head ?? '']));
  return out;
}
