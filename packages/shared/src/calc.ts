import type { LineItemInput, OrderTotalsInput, OrderTotals, PaymentRecord } from './types';

export function fmtKsh(n: number): string {
  return 'Ksh ' + Math.round(n || 0).toLocaleString('en-KE');
}

/**
 * Display-only date formatting: 'YYYY-MM-DD' -> 'DD/MM/YYYY'. Storage,
 * comparisons (isOverdue, date-range filters) and <input type="date">
 * values all stay ISO — only the rendered text changes.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

/** The time of day an order was captured, in Nairobi time whatever the machine's own zone: "14:32" (blank when it was not recorded). */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** "23/10/2026 14:32" — the order's date, with the time it was captured when that was recorded. */
export function fmtDateTime(date: string | null | undefined, capturedAt: string | null | undefined): string {
  const t = fmtTime(capturedAt);
  return t ? fmtDate(date) + ' ' + t : fmtDate(date);
}

export function buildLineTotal(li: LineItemInput): number {
  const qty = Number(li.qty) || 0;
  const price = Number(li.unitPrice) || 0;
  const heatPressFee = Number(li.heatPressFee) || 0;
  const pct = Number(li.discountPct) || 0;
  const amt = Number(li.discountAmt) || 0;
  return Math.max(0, qty * (price + heatPressFee) * (1 - pct / 100) - amt);
}

export function computeOrderTotals(order: OrderTotalsInput, payments: PaymentRecord[] = []): OrderTotals {
  const subtotal = order.lineItems.reduce((a, li) => a + buildLineTotal(li), 0);
  const opct = Number(order.orderDiscountPct) || 0;
  const oamt = Number(order.orderDiscountAmt) || 0;
  const grandTotal = Math.max(0, subtotal * (1 - opct / 100) - oamt);
  const paidTotal = payments.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const balanceDue = Math.max(0, grandTotal - paidTotal);
  const paidPct = grandTotal > 0 ? Math.min(100, (paidTotal / grandTotal) * 100) : paidTotal > 0 ? 100 : 0;
  return { subtotal, grandTotal, orderDiscount: subtotal - grandTotal, paidTotal, balanceDue, paidPct };
}

// Corporate invoices get a dueDate from the client's credit terms; walk-in/DTF
// orders left with a balance at capture now get one too (see
// WALKIN_INVOICE_DUE_DAYS), so this applies uniformly regardless of kind —
// any order sitting at status 'Invoice' past its due date, still owing
// money, is overdue.
export function isOverdue(kind: 'walkin' | 'corporate', status: string, dueDate: string | null | undefined, balanceDue: number, today: string): boolean {
  return status === 'Invoice' && !!dueDate && dueDate < today && balanceDue > 0;
}

export function addDays(dateStr: string, days: number): string {
  // UTC arithmetic: the date is a calendar date, so the machine's own time zone must not move it a day
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date as 'YYYY-MM-DD' — the calendar day in Nairobi, whatever zone the server or browser is in (an order keyed at 01:00 in Nairobi belongs to that day, not the day before). */
export function todayStr(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function exceedsDiscountCeiling(order: OrderTotalsInput, ceilingPct: number): boolean {
  const orderPct = Number(order.orderDiscountPct) || 0;
  if (orderPct > ceilingPct) return true;
  return order.lineItems.some((li) => (Number(li.discountPct) || 0) > ceilingPct);
}
