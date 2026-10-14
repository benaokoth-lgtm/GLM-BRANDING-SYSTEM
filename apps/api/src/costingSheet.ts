import { COSTING_BASIS_LABEL, COSTING_JOB_LABEL, PRINT_FEE_LABELS } from '@glm/shared';
import type { CostingRateRow, PrintSettings } from '@glm/shared';
import type { Cell } from './xlsx';

// The supplier price-check sheet: every material, service, paper and fee that Job Costing costs a job from, with the rate the system holds now and empty columns for what each supplier
// quotes — to check supplier prices against the system, and then to feed the new ones into Job Costing → Rates (and Brochures & eulogies → Rates).

export const COSTING_SHEET_HEADERS = ['No.', 'Section', 'Item', 'Kind', 'Used for', 'Charged', 'Finish / note', 'Ticked in a new costing', 'Current rate in the system (KES, VAT excluded)', 'Supplier 1 quote', 'Supplier 2 quote', 'Supplier 3 quote', 'Supplier, date, VAT included or not?'];
export const COSTING_SHEET_WIDTHS = [6, 30, 38, 11, 34, 22, 22, 14, 22, 15, 15, 15, 34];

const ONLY_FOR: Record<string, string> = { lam: 'Laminated cards only', frost: 'Frosted cards only' };

export function costingSheetRows(rates: CostingRateRow[], print: PrintSettings): Cell[][] {
  const out: Cell[][] = [COSTING_SHEET_HEADERS];
  let n = 0;
  const add = (section: string, item: string, kind: string, usedFor: string, charged: string, note: string, ticked: string, current: number) => out.push([++n, section, item, kind, usedFor, charged, note, ticked, current]);

  // business cards, indoor and outdoor signage
  const sorted = [...rates].filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const kind of ['material', 'service'] as const) {
    for (const r of sorted.filter((x) => x.kind === kind)) {
      add('Business cards & signage', r.name, kind === 'material' ? 'Material' : 'Service', r.jobTypes.map((t) => COSTING_JOB_LABEL[t]).join(', '), COSTING_BASIS_LABEL[r.basis], ONLY_FOR[r.onlyFor] ?? '', r.defaultOn ? 'Yes' : 'Optional extra', r.cost);
    }
  }

  // brochures, eulogies and company profiles: the printer's price for an A3 sheet, then the fees
  for (const p of print.papers) {
    add('Brochures & eulogies — paper', `${p.name}, printed one side`, 'Material', 'Eulogies, profiles, brochures', 'per A3 sheet', 'One side', 'Yes', p.one);
    add('Brochures & eulogies — paper', `${p.name}, printed both sides`, 'Material', 'Eulogies, profiles, brochures', 'per A3 sheet', 'Both sides', 'Yes', p.two);
  }
  for (const f of PRINT_FEE_LABELS) {
    if (f.key === 'waste') continue; // an allowance for spoilage, not a price
    add('Brochures & eulogies — services & fees', f.label, 'Service', f.key === 'staple' || f.key === 'trim' || f.key === 'fold' ? 'Eulogies, company profiles' : f.key === 'lam' ? 'Eulogies, profiles, brochures' : f.key === 'designBr' ? 'Brochures' : f.key === 'designEu' ? 'Eulogies' : f.key === 'designPr' ? 'Company profiles' : 'Eulogies, profiles, brochures', f.unit.replace('KES / ', 'per '), '', f.key === 'fold' ? 'Yes (can be switched off)' : 'Yes', print.fees[f.key]);
  }
  return out;
}
