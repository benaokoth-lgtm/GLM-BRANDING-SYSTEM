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

export function buildLineTotal(li: LineItemInput): number {
  const qty = Number(li.qty) || 0;
  const price = Number(li.unitPrice) || 0;
  const pct = Number(li.discountPct) || 0;
  const amt = Number(li.discountAmt) || 0;
  return Math.max(0, qty * price * (1 - pct / 100) - amt);
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

export function isOverdue(kind: 'walkin' | 'corporate', status: string, dueDate: string | null | undefined, balanceDue: number, today: string): boolean {
  return kind === 'corporate' && status === 'Invoice' && !!dueDate && dueDate < today && balanceDue > 0;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exceedsDiscountCeiling(order: OrderTotalsInput, ceilingPct: number): boolean {
  const orderPct = Number(order.orderDiscountPct) || 0;
  if (orderPct > ceilingPct) return true;
  return order.lineItems.some((li) => (Number(li.discountPct) || 0) > ceilingPct);
}
