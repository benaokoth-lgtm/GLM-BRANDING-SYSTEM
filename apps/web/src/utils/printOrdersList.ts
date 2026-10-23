import { fmtDateTime, fmtKsh } from '@glm/shared';
import type { OrderSummary } from '../api/models';

// All Orders → Print list: the orders on screen (after the filters and the dates picked on the calendar) as one A4 sheet — order, date and time, type, client, staff, status, total and balance,
// with a total at the bottom. It prints the whole filtered list, not just the page being looked at.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const typeOf = (o: OrderSummary) => (o.kind === 'corporate' ? 'Corporate' : o.dtfKind === 'film' ? 'Film' : o.dtfKind === 'artwork' ? 'Artwork' : o.channel === 'dtf' ? 'DTF' : 'General');

export function printOrdersList(rows: OrderSummary[], meta: { company: string; title: string; period: string; filters: string; printedBy: string }): boolean {
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return false;
  const total = rows.reduce((a, o) => a + o.totals.grandTotal, 0);
  const balance = rows.reduce((a, o) => a + (o.status === 'Quote' ? 0 : o.totals.balanceDue), 0);
  const body = rows
    .map(
      (o) => `<tr>
        <td>${esc(o.orderNo)}</td>
        <td>${esc(fmtDateTime(o.createdDate, o.capturedAt))}</td>
        <td>${esc(typeOf(o))}</td>
        <td>${esc(o.kind === 'corporate' ? o.corporateClient?.name ?? '—' : o.customerName ?? '—')}</td>
        <td>${esc(o.staff.name)}</td>
        <td>${esc(o.status)}</td>
        <td class="r">${fmtKsh(o.totals.grandTotal)}</td>
        <td class="r">${o.status === 'Quote' ? '—' : o.totals.balanceDue > 0.005 ? fmtKsh(o.totals.balanceDue) : '—'}</td>
      </tr>`,
    )
    .join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.4 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #444; margin: 0 0 10px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; background: #eee; border-bottom: 2px solid #333; padding: 5px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td { border-bottom: 1px solid #ccc; padding: 4px 6px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  tfoot td { border-top: 2px solid #333; font-weight: 700; }
  tr { break-inside: avoid; }
  .foot { margin-top: 10px; color: #555; font-size: 11px; }
</style></head><body>
  <h1>${esc(meta.company)} — ${esc(meta.title)}</h1>
  <p class="sub">${esc(meta.period)}${meta.filters ? ' · ' + esc(meta.filters) : ''} · ${rows.length} order${rows.length === 1 ? '' : 's'}</p>
  <table>
    <thead><tr><th>Order</th><th>Date</th><th>Type</th><th>Client</th><th>Staff</th><th>Status</th><th class="r">Total</th><th class="r">Balance</th></tr></thead>
    <tbody>${body || '<tr><td colspan="8">No orders in this selection.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="6">Total (${rows.length})</td><td class="r">${fmtKsh(total)}</td><td class="r">${fmtKsh(balance)}</td></tr></tfoot>
  </table>
  <p class="foot">Printed ${esc(new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }))} by ${esc(meta.printedBy)}.</p>
  <script>window.onload = function () { window.focus(); window.print(); };</script>
</body></html>`);
  w.document.close();
  return true;
}
