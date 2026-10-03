import type { DraftLineItem } from '../api/models';

/** The supplier quote and mark-up on a draft line, ready to send — empty when the line has none (staff never have them). */
export function costPayload(li: DraftLineItem) {
  const cost = Number(li.supplierCost);
  if (!(cost > 0)) return {};
  return {
    supplierCost: cost,
    markupType: li.markupType === 'amount' ? ('amount' as const) : ('percent' as const),
    markupValue: Number(li.markupValue) || 0,
    supplierName: li.supplierName?.trim() || undefined,
  };
}
