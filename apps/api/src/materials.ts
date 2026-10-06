import { prisma } from './db';

/**
 * Price-list lines made before items had sizes carry only a name. Make that name the item (no size), once, so every line has its item.
 */
export async function ensureMaterialItems(): Promise<void> {
  const rows = await prisma.material.findMany({ where: { item: '' }, select: { id: true, name: true } });
  for (const m of rows) await prisma.material.update({ where: { id: m.id }, data: { item: m.name } });
}

let ensuring: Promise<void> | null = null;
export function ensureMaterialItemsOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureMaterialItems().finally(() => (ensuring = null));
  return ensuring;
}
