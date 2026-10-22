// Day close: the figures behind the daily reconciliation (Finance → Day close). What was received, by method, person and till; the cash each till should hold; what customers still owe; what NCBA says it took
// against what was recorded on orders; which days were not closed; and the evening summary built from all of it. Routes are in routes/dayClose.ts, the evening send in daySummary.ts.
import { addDays, fmtKsh, todayStr } from '@glm/shared';
import { prisma } from './db';
import { orderListInclude, serializeSummary } from './routes/orders';
import type { ListOrder } from './routes/orders';

/** A variance up to this is amber (a small slip); above it is red. */
export const AMBER_UP_TO = 200;
export const DENOMINATIONS = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1];
export const METHODS = ['Cash', 'M-Pesa', 'Bank', 'Card', 'Cheque'];

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Tills ───────────────────────────────────────────────────────────────────
/** The tills, main first. There is always a main till: it is made the first time anything here is used. Everyone without a till of their own takes cash at the main till. */
export async function ensureTills() {
  let tills = await prisma.till.findMany({ orderBy: [{ isMain: 'desc' }, { name: 'asc' }] });
  if (!tills.some((t) => t.isMain)) {
    const named = tills.find((t) => t.name === 'Main till');
    if (named) await prisma.till.update({ where: { id: named.id }, data: { isMain: true, active: true } });
    else await prisma.till.create({ data: { name: 'Main till', isMain: true } }).catch(() => undefined);
    tills = await prisma.till.findMany({ orderBy: [{ isMain: 'desc' }, { name: 'asc' }] });
  }
  return tills;
}

/** Which till each person takes cash at (people with no till, or one that has been switched off, are at the main till). */
async function tillResolver() {
  const tills = await ensureTills();
  const main = tills.find((t) => t.isMain)!;
  const active = new Set(tills.filter((t) => t.active).map((t) => t.id));
  const users = await prisma.user.findMany({ where: { tillId: { not: null } }, select: { id: true, name: true, tillId: true } });
  const byId = new Map(users.map((u) => [u.id, u.tillId!]));
  const byName = new Map(users.map((u) => [u.name, u.tillId!]));
  const fix = (t: number | undefined) => (t !== undefined && active.has(t) ? t : main.id);
  return {
    tills,
    main,
    activeTills: tills.filter((t) => t.active),
    ofUser: (id: number | null | undefined) => fix(id == null ? undefined : byId.get(id)),
    ofName: (name: string) => fix(byName.get(name)),
  };
}

// ── Outstanding ─────────────────────────────────────────────────────────────
/** The invoices still owing as at the end of `date` (payments after it are ignored), with their balance and how overdue they are. */
export async function outstandingAsAt(date: string) {
  const orders: ListOrder[] = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, createdDate: { lte: date }, OR: [{ status: 'Invoice' }, { payments: { some: { date: { gt: date } } } }] },
    include: orderListInclude,
  });
  const rows: { id: number; orderNo: string; customer: string; createdDate: string; dueDate: string | null; balance: number; daysOverdue: number; staff: string }[] = [];
  for (const o of orders) {
    const s = serializeSummary({ ...o, payments: o.payments.filter((p) => p.date <= date) });
    if (s.totals.balanceDue < 0.01) continue;
    const days = o.dueDate && o.dueDate < date ? Math.round((Date.parse(date) - Date.parse(o.dueDate)) / 86400000) : 0;
    rows.push({ id: o.id, orderNo: o.orderNo, customer: o.corporateClient?.name || o.customerName || '—', createdDate: o.createdDate, dueDate: o.dueDate, balance: round2(s.totals.balanceDue), daysOverdue: days, staff: o.staff.name });
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);
  return rows;
}

const BANDS: [string, (d: number) => boolean][] = [
  ['Not yet due', (d) => d <= 0],
  ['1–7 days overdue', (d) => d >= 1 && d <= 7],
  ['8–30 days', (d) => d >= 8 && d <= 30],
  ['31–60 days', (d) => d >= 31 && d <= 60],
  ['Over 60 days', (d) => d > 60],
];

// ── NCBA tie-out ────────────────────────────────────────────────────────────
/**
 * What NCBA says it took on the day (its notifications) against what is on orders. Money NCBA took is settled to the bank the same way whatever happens to it here, so the total is what the bank should
 * show; a receipt that is not on any order is money in the bank (or about to be) with no sale against it yet; and an M-Pesa payment recorded on an order that NCBA never sent was not paid through our NCBA
 * Paybill — a wrong code, or money that went somewhere else.
 */
export async function ncbaTieOut(date: string) {
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(`${addDays(date, 1)}T00:00:00.000Z`);
  const [everSeen, notes, ignoredCount] = await Promise.all([
    prisma.ncbaNotification.count(),
    prisma.ncbaNotification.findMany({ where: { receivedAt: { gte: from, lt: to }, outcome: { in: ['Matched', 'Received', 'Held'] } }, orderBy: { id: 'asc' } }),
    prisma.ncbaNotification.count({ where: { receivedAt: { gte: from, lt: to }, outcome: { in: ['Duplicate', 'Rejected'] } } }),
  ]);
  const mpesaToday = await prisma.payment.findMany({
    where: { date, method: 'M-Pesa' },
    include: { order: { select: { orderNo: true, customerName: true, corporateClient: { select: { name: true } } } }, mpesaTransaction: { select: { mpesaReceipt: true, checkoutRequestId: true } } },
  });
  const codesOf = (p: (typeof mpesaToday)[number]) => [p.reference, p.mpesaTransaction?.mpesaReceipt].filter((c): c is string => !!c).map((c) => c.toUpperCase());
  const wanted = new Set<string>([...notes.map((n) => n.transId.toUpperCase()), ...mpesaToday.flatMap(codesOf)]);
  const known = wanted.size ? await prisma.ncbaNotification.findMany({ where: { transId: { in: [...wanted] } }, select: { transId: true } }) : [];
  const ncbaCodes = new Set(known.map((k) => k.transId.toUpperCase()));
  // every payment (on any day) that carries one of the codes NCBA sent today: that receipt is on an order
  const codeList = notes.map((n) => n.transId).filter(Boolean);
  const carrying = codeList.length
    ? await prisma.payment.findMany({ where: { OR: [{ reference: { in: codeList } }, { mpesaTransaction: { mpesaReceipt: { in: codeList } } }] }, select: { reference: true, mpesaTransaction: { select: { mpesaReceipt: true } } } })
    : [];
  const onOrder = new Set(carrying.flatMap((p) => [p.reference, p.mpesaTransaction?.mpesaReceipt]).filter((c): c is string => !!c).map((c) => c.toUpperCase()));

  const sent = notes.reduce((a, n) => a + n.amount, 0);
  const notOnOrder = notes.filter((n) => !onOrder.has(n.transId.toUpperCase()));
  const other = mpesaToday.filter((p) => !(p.mpesaTransaction?.checkoutRequestId ?? '').startsWith('NCBA-') && !codesOf(p).some((c) => ncbaCodes.has(c)));
  return {
    active: everSeen > 0,
    sent: { count: notes.length, amount: round2(sent) },
    onOrders: { count: notes.length - notOnOrder.length, amount: round2(sent - notOnOrder.reduce((a, n) => a + n.amount, 0)) },
    notOnOrder: { count: notOnOrder.length, amount: round2(notOnOrder.reduce((a, n) => a + n.amount, 0)), receipts: notOnOrder.slice(0, 100).map((n) => ({ id: n.id, receipt: n.transId, amount: n.amount, phone: n.phone, payer: n.payerName, billRef: n.billRef, outcome: n.outcome })) },
    otherMpesa: { count: other.length, amount: round2(other.reduce((a, p) => a + p.amount, 0)), payments: other.slice(0, 100).map((p) => ({ id: p.id, orderNo: p.order.orderNo, customer: p.order.corporateClient?.name || p.order.customerName || '—', amount: p.amount, reference: p.reference ?? p.mpesaTransaction?.mpesaReceipt ?? '' })) },
    duplicatesOrRejected: ignoredCount,
    // NCBA settles what it took into the bank account daily
    expectedBankSettlement: round2(sent),
  };
}

// ── One day, live ───────────────────────────────────────────────────────────
/** Everything the system knows about a day: for one till (`tillId`) or all of them (null). */
export async function liveDay(date: string, tillId: number | null) {
  const r = await tillResolver();
  const [payments, refunds] = await Promise.all([
    prisma.payment.findMany({ where: { date }, include: { order: { select: { id: true, orderNo: true, customerName: true, corporateClient: { select: { name: true } } } }, staff: { select: { name: true } } }, orderBy: { id: 'asc' } }),
    prisma.adjustmentNote.findMany({ where: { type: 'Credit', date, refundAmt: { gt: 0 } } }),
  ]);
  // each till's cash: received and refunded
  const cashOf = new Map<number, { received: number; refunds: number }>();
  for (const t of r.activeTills) cashOf.set(t.id, { received: 0, refunds: 0 });
  for (const p of payments) if (p.method === 'Cash') cashOf.get(r.ofUser(p.staffId))!.received = round2(cashOf.get(r.ofUser(p.staffId))!.received + p.amount);
  for (const n of refunds) if ((n.refundMethod ?? 'Cash') === 'Cash') cashOf.get(r.ofName(n.createdByName))!.refunds = round2(cashOf.get(r.ofName(n.createdByName))!.refunds + n.refundAmt);

  const floatOf = new Map<number, number>();
  const closes = await prisma.dayClose.findMany({ where: { date } });
  for (const t of r.activeTills) {
    const prev = await prisma.dayClose.findFirst({ where: { tillId: t.id, date: { lt: date } }, orderBy: { date: 'desc' } });
    floatOf.set(t.id, prev?.floatCarried ?? 0);
  }
  const closeOf = new Map(closes.map((c) => [c.tillId, c]));
  const tills = r.activeTills.map((t) => {
    const c = cashOf.get(t.id)!;
    const opening = floatOf.get(t.id)!;
    const k = closeOf.get(t.id);
    return { id: t.id, name: t.name, isMain: t.isMain, openingFloat: opening, received: c.received, refunds: c.refunds, expected: round2(opening + c.received - c.refunds), close: k ? { status: k.status, counted: k.countedCash, variance: k.variance, banked: k.banked } : null };
  });
  const scope = tillId == null ? tills : tills.filter((t) => t.id === tillId);
  const cash = {
    openingFloat: round2(scope.reduce((a, t) => a + t.openingFloat, 0)),
    received: round2(scope.reduce((a, t) => a + t.received, 0)),
    refunds: round2(scope.reduce((a, t) => a + t.refunds, 0)),
    expected: round2(scope.reduce((a, t) => a + t.expected, 0)),
  };

  const mine = tillId == null ? payments : payments.filter((p) => r.ofUser(p.staffId) === tillId);
  const byMethod = new Map<string, { method: string; count: number; amount: number }>();
  for (const m of METHODS) byMethod.set(m, { method: m, count: 0, amount: 0 });
  const byPerson = new Map<string, { person: string; cash: number; other: number; count: number }>();
  for (const p of mine) {
    const m = byMethod.get(p.method) ?? { method: p.method, count: 0, amount: 0 };
    m.count++;
    m.amount = round2(m.amount + p.amount);
    byMethod.set(p.method, m);
    const name = p.staff?.name ?? 'Not recorded';
    const row = byPerson.get(name) ?? { person: name, cash: 0, other: 0, count: 0 };
    if (p.method === 'Cash') row.cash = round2(row.cash + p.amount);
    else row.other = round2(row.other + p.amount);
    row.count++;
    byPerson.set(name, row);
  }
  const received = round2(mine.reduce((a, p) => a + p.amount, 0));

  // what is owed: as at this day, and as at the day before, and how it moved
  const [closing, opening, raised, ncba] = await Promise.all([
    outstandingAsAt(date),
    outstandingAsAt(addDays(date, -1)),
    prisma.order.findMany({ where: { status: { not: 'Quote' }, createdDate: date }, include: orderListInclude }),
    ncbaTieOut(date),
  ]);
  const sum = (rows: { balance: number }[]) => round2(rows.reduce((a, x) => a + x.balance, 0));
  const raisedToday = round2(raised.reduce((a, o) => a + serializeSummary({ ...o, payments: [] }).totals.grandTotal, 0));
  const allReceived = round2(payments.reduce((a, p) => a + p.amount, 0));
  const closingTotal = sum(closing);
  const openingTotal = sum(opening);
  return {
    date,
    tillId,
    tills,
    allClosed: tills.every((t) => t.received + t.refunds === 0 || t.close),
    byMethod: [...byMethod.values()],
    received,
    byPerson: [...byPerson.values()].sort((a, b) => b.cash + b.other - (a.cash + a.other)),
    payments: mine.slice(0, 500).map((p) => ({ id: p.id, orderId: p.orderId, orderNo: p.order.orderNo, customer: p.order.corporateClient?.name || p.order.customerName || '—', method: p.method, amount: p.amount, reference: p.reference ?? '', by: p.staff?.name ?? '' })),
    cash,
    outstanding: {
      opening: openingTotal,
      raisedToday,
      receivedToday: allReceived,
      // credit notes, discounts given after the sale and anything else that changed what is owed
      otherChanges: round2(closingTotal - (openingTotal + raisedToday - allReceived)),
      closing: closingTotal,
      bands: BANDS.map(([label, test]) => {
        const rows = closing.filter((x) => test(x.daysOverdue));
        return { label, count: rows.length, amount: sum(rows) };
      }),
      invoices: closing.slice(0, 200),
      invoiceCount: closing.length,
    },
    ncba,
  };
}

export type LiveDay = Awaited<ReturnType<typeof liveDay>>;

// ── Days not closed ─────────────────────────────────────────────────────────
/** Past days (up to a week back) on which a till took cash and was not closed, and cash-ups waiting for approval. */
export async function reminder() {
  const today = todayStr();
  const from = addDays(today, -7);
  const r = await tillResolver();
  const [payments, closes, submitted] = await Promise.all([
    prisma.payment.findMany({ where: { date: { gte: from, lt: today }, method: 'Cash' }, select: { date: true, amount: true, staffId: true } }),
    prisma.dayClose.findMany({ where: { date: { gte: from, lt: today } }, select: { date: true, tillId: true } }),
    prisma.dayClose.findMany({ where: { status: 'Submitted', date: { lt: today } }, orderBy: { date: 'desc' }, take: 20 }),
  ]);
  const closed = new Set(closes.map((c) => `${c.date}|${c.tillId}`));
  const cash = new Map<string, { date: string; tillId: number; cash: number }>();
  for (const p of payments) {
    const tillId = r.ofUser(p.staffId);
    const k = `${p.date}|${tillId}`;
    const row = cash.get(k) ?? { date: p.date, tillId, cash: 0 };
    row.cash = round2(row.cash + p.amount);
    cash.set(k, row);
  }
  const nameOf = new Map(r.tills.map((t) => [t.id, t.name]));
  return {
    unclosed: [...cash.entries()].filter(([k, v]) => !closed.has(k) && v.cash > 0).map(([, v]) => ({ ...v, tillName: nameOf.get(v.tillId) ?? 'Till' })).sort((a, b) => b.date.localeCompare(a.date)),
    awaiting: submitted.map((c) => ({ date: c.date, tillId: c.tillId, tillName: nameOf.get(c.tillId) ?? 'Till', submittedByName: c.submittedByName, variance: c.variance })),
  };
}

// ── The evening summary ─────────────────────────────────────────────────────
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
const shilling = (n: number) => fmtKsh(n);

/** The summary of a day: five short values for the approved template, and the same as a plain message. */
export async function summaryFor(date: string) {
  const day = await liveDay(date, null);
  const rem = await reminder();
  const cashReceived = day.byMethod.find((m) => m.method === 'Cash')?.amount ?? 0;
  const others = day.byMethod.filter((m) => m.method !== 'Cash' && m.amount > 0).map((m) => `${m.method} ${shilling(m.amount)}`);
  const received = `${shilling(day.received)} (Cash ${shilling(cashReceived)}${others.length ? ', ' + others.join(', ') : ''})`;
  const multi = day.tills.length > 1;
  const cashLines = day.tills
    .filter((t) => t.received + t.refunds > 0 || t.close)
    .map((t) => {
      const who = multi ? `${t.name}: ` : '';
      if (!t.close) return `${who}not counted yet (expected ${shilling(t.expected)})`;
      const v = t.close.variance;
      return `${who}counted ${shilling(t.close.counted)}, ${Math.abs(v) < 0.5 ? 'balanced' : v < 0 ? `short ${shilling(-v)}` : `over ${shilling(v)}`} (${t.close.status === 'Approved' ? 'approved' : 'awaiting approval'})`;
    });
  const cash = cashLines.length ? cashLines.join('; ') : 'no cash today';
  const overdue = day.outstanding.bands.filter((b) => b.label !== 'Not yet due').reduce((a, b) => a + b.amount, 0);
  const owed = `${shilling(day.outstanding.closing)}${overdue > 0 ? ` (${shilling(overdue)} overdue)` : ''}`;
  const notes: string[] = [];
  if (day.ncba.active) notes.push(`NCBA sent ${shilling(day.ncba.sent.amount)}${day.ncba.notOnOrder.count ? `; ${day.ncba.notOnOrder.count} receipt${day.ncba.notOnOrder.count === 1 ? '' : 's'} (${shilling(day.ncba.notOnOrder.amount)}) not on an order` : '; all on orders'}${day.ncba.otherMpesa.count ? `; ${day.ncba.otherMpesa.count} M-Pesa payment${day.ncba.otherMpesa.count === 1 ? '' : 's'} NCBA did not send` : ''}`);
  const unclosed = rem.unclosed.map((u) => `${u.tillName} ${dayLabel(u.date)}`);
  if (rem.unclosed.length) notes.push(`Not closed: ${unclosed.join(', ')}`);
  else notes.push('No earlier day is waiting to be closed');
  const label = dayLabel(date);
  return {
    date,
    params: [label, received, cash, owed, notes.join('. ')] as [string, string, string, string, string],
    text: [`GLM Branding — ${label}`, `Received: ${received}`, `Cash: ${cash}`, `Owed by customers: ${owed}`, ...notes].join('\n'),
  };
}
