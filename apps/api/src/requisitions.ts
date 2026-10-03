import { prisma } from './db';

// Stock requisitions have a reference number (REQ-0001…) and any number of lines. Older requisitions were one material and
// one quantity with no reference; on start-up (and before any requisition is listed) each is given the next free reference and
// its material/quantity becomes its first line. Safe to run any number of times.

export const formatRequisitionRef = (n: number) => `REQ-${String(n).padStart(4, '0')}`;

/** The next free number: one above the highest REQ-nnnn ever issued. */
export async function nextRequisitionNumber(): Promise<number> {
  const rows = await prisma.stockRequisition.findMany({ where: { ref: { not: null } }, select: { ref: true } });
  let highest = 0;
  for (const r of rows) {
    const m = /^REQ-(\d+)$/.exec(r.ref ?? '');
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest + 1;
}

export async function ensureRequisitions(): Promise<void> {
  const rows = await prisma.stockRequisition.findMany({ include: { lines: true }, orderBy: { id: 'asc' } });
  let next = await nextRequisitionNumber();
  for (const r of rows) {
    if (!r.ref) {
      await prisma.stockRequisition.update({ where: { id: r.id }, data: { ref: formatRequisitionRef(next++) } });
    }
    if (r.lines.length === 0 && r.materialId && r.qty) {
      await prisma.stockRequisitionLine.create({ data: { requisitionId: r.id, materialId: r.materialId, qty: r.qty } });
    }
  }
}

let ensuring: Promise<void> | null = null;
/** Runs ensureRequisitions at most once at a time. */
export function ensureRequisitionsOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureRequisitions().finally(() => (ensuring = null));
  return ensuring;
}
