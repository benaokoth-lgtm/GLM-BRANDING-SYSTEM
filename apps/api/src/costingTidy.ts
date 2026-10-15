import { tidyCostingSummary } from '@glm/shared';
import { prisma } from './db';

// A card job used to be described, on its quote and on the order made from it, as "1000 cards · Laminated · 49 A3 sheets": how many sheets it takes is our production detail, not the client's.
// It is now "1000cards-laminated". New quotes are written that way; this puts the ones already saved (and the order lines made from them) right. It only touches text in the old form, so
// it can run at every start.

let done: Promise<number> | null = null;

export async function tidyCostingSummaries(): Promise<number> {
  let changed = 0;
  const quotes = await prisma.costingQuote.findMany({ where: { summary: { contains: 'A3 sheets' } }, select: { id: true, summary: true } });
  for (const q of quotes) {
    const next = tidyCostingSummary(q.summary);
    if (next !== q.summary) {
      await prisma.costingQuote.update({ where: { id: q.id }, data: { summary: next } });
      changed++;
    }
  }
  const lines = await prisma.orderLineItem.findMany({ where: { description: { contains: 'A3 sheets' } }, select: { id: true, description: true } });
  for (const l of lines) {
    const next = tidyCostingSummary(l.description);
    if (next !== l.description) {
      await prisma.orderLineItem.update({ where: { id: l.id }, data: { description: next } });
      changed++;
    }
  }
  return changed;
}

export const tidyCostingSummariesOnce = () => (done ??= tidyCostingSummaries());
