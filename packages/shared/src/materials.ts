// The stock price list: an ITEM (a polo shirt) comes in SIZES (L, XL …), and each size is its own line with its own price and stock. The line's
// name — what orders, purchases and stock show — is the item and its size together.

/** "Polo Shirt" + "L" → "Polo Shirt — L"; an item with no size is just its name. */
export function materialName(item: string, size: string | null | undefined): string {
  const i = item.trim().replace(/\s+/g, ' ');
  const z = (size ?? '').trim().replace(/\s+/g, ' ');
  return z ? `${i} — ${z}` : i;
}

/** Units a stock item is counted in (suggestions — any unit can be typed). */
export const MATERIAL_UNITS = ['piece', 'pair', 'set', 'pack', 'box', 'roll', 'metre', 'sheet', 'kg', 'litre'] as const;

const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', 'xxxl', '3xl', '4xl', '5xl'];

/** Where a size sorts: clothing sizes in order (S, M, L, XL …), then numbers (38, 40 …) by value, then anything else A–Z. */
export function sizeRank(size: string): [number, number, string] {
  const z = size.trim().toLowerCase();
  const i = SIZE_ORDER.indexOf(z);
  if (i >= 0) return [0, i, z];
  const n = parseFloat(z);
  if (!Number.isNaN(n) && /^[\d.]+/.test(z)) return [1, n, z];
  return [2, 0, z];
}

export function compareSizes(a: string, b: string): number {
  const x = sizeRank(a);
  const y = sizeRank(b);
  return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
}
