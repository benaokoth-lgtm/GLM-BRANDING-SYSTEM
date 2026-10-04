import { buildLineTotal, defaultBusinessHeadName, GENERAL_ORDER_HEAD } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

// Which line of business an order belongs to. The rule is the one Sales by Business Head uses: a service sells for its business head (or the
// head its name suggests); materials are sold under General Order.

export const DTF_HEAD = 'DTF Printing';

type HeadLine = { service: { name: string; businessHead?: { name: string } | null } | null };

export function lineHead(li: HeadLine): string {
  return li.service ? li.service.businessHead?.name ?? defaultBusinessHeadName(li.service.name) : GENERAL_ORDER_HEAD;
}

/** Every head an order sells for (an order can have lines in more than one). */
export function orderHeads(lines: HeadLine[]): string[] {
  return [...new Set(lines.map(lineHead))];
}

/** The head an order is worked under (Production, Quality control): the one that carries most of its value. */
export function primaryHead(lines: (HeadLine & LineItemInput)[]): string {
  if (lines.length === 0) return GENERAL_ORDER_HEAD;
  const value = new Map<string, number>();
  for (const li of lines) value.set(lineHead(li), (value.get(lineHead(li)) ?? 0) + buildLineTotal(li));
  return [...value.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export type DtfKind = 'film' | 'artwork' | null;

/** The heading an order sits under in Production and Quality control: DTF Printing is split into its film sales and artwork sales. */
export function headGroup(head: string, dtfKind: DtfKind): string {
  if (dtfKind === 'film') return `${DTF_HEAD} — Film sales`;
  if (dtfKind === 'artwork') return `${DTF_HEAD} — Artwork sales`;
  return head;
}
