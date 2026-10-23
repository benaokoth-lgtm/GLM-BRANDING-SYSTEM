// A possible duplicate at capture: the same client (phone, or a real name, or a corporate account) with the same total, captured in the last 24 hours. The capture is stopped with a question —
// "this looks like W-1042, captured 4 minutes ago: capture it anyway?" — and goes through when the person confirms (the screen sends confirmDuplicate). It never blocks for good: a regular client can
// order the same thing twice on purpose. Walk-in orders with no name and no phone cannot be matched and are not checked.
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { WALK_IN_CLIENT } from '@glm/shared';
import { prisma } from './db';
import { orderListInclude, serializeSummary } from './routes/orders';

export interface DupHit {
  id: number;
  orderNo: string;
  customer: string;
  total: number;
  minutesAgo: number;
}

export class DuplicateError extends Error {
  constructor(public hits: DupHit[]) {
    super('Possible duplicate order');
  }
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const phoneKey = (s: string | null | undefined) => (digits(s).length >= 9 ? digits(s).slice(-9) : '');
const nameKey = (s: string | null | undefined) => {
  const n = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n && n !== WALK_IN_CLIENT.toLowerCase() && n !== 'walk-in' ? n : '';
};

export async function findDuplicates(db: Prisma.TransactionClient | typeof prisma, q: { phone?: string | null; name?: string | null; corporateClientId?: number | null; total: number }): Promise<DupHit[]> {
  const on = await db.dayCloseSettings.findUnique({ where: { id: 1 } });
  if (on && !on.warnDuplicateOrders) return [];
  const pk = phoneKey(q.phone);
  const nk = nameKey(q.name);
  if (!pk && !nk && !q.corporateClientId) return [];
  const since = new Date(Date.now() - 24 * 3600_000);
  const recent = await db.order.findMany({ where: { status: { not: 'Quote' }, capturedAt: { gte: since } }, include: orderListInclude, orderBy: { id: 'desc' }, take: 400 });
  const hits: DupHit[] = [];
  for (const o of recent) {
    const sameClient = (q.corporateClientId && o.corporateClientId === q.corporateClientId) || (pk && phoneKey(o.phone) === pk) || (nk && nameKey(o.customerName) === nk);
    if (!sameClient) continue;
    const total = serializeSummary(o).totals.grandTotal;
    if (Math.abs(total - q.total) > 0.5) continue;
    hits.push({ id: o.id, orderNo: o.orderNo, customer: o.corporateClient?.name || o.customerName || '', total, minutesAgo: Math.max(0, Math.round((Date.now() - o.capturedAt!.getTime()) / 60_000)) });
  }
  return hits.slice(0, 3);
}

const ago = (m: number) => (m < 1 ? 'a moment ago' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago`);

/** The 409 the screens turn into a "capture it anyway?" question. */
export function sendDuplicate(res: Response, err: DuplicateError) {
  const list = err.hits.map((h) => `${h.orderNo} (${h.customer || 'same client'}, Ksh ${Math.round(h.total).toLocaleString('en-KE')}, captured ${ago(h.minutesAgo)})`).join('; ');
  return res.status(409).json({ code: 'POSSIBLE_DUPLICATE', error: `This looks like a duplicate of ${list}. Open that order instead, or capture this one anyway if it really is a second order.`, duplicates: err.hits });
}

/** Throws DuplicateError when a likely duplicate exists and the person has not confirmed. */
export async function assertNotDuplicate(db: Prisma.TransactionClient | typeof prisma, q: Parameters<typeof findDuplicates>[1], confirmed: boolean) {
  if (confirmed) return;
  const hits = await findDuplicates(db, q);
  if (hits.length) throw new DuplicateError(hits);
}
