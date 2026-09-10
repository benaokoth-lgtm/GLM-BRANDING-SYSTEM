import { fmtKsh } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';

const THERMAL_WIDTH_MM = 80;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ticketItemsHtml(order: OrderDetail): string {
  return order.lineItems
    .map((li) => {
      const label = esc(li.serviceName + (li.materialName ? ' + ' + li.materialName : ''));
      const unit = li.itemType === 'per-metre' ? 'm' : '';
      const discNote =
        li.discountPct || li.discountAmt
          ? `<div class="disc">disc ${li.discountPct}% / ${fmtKsh(li.discountAmt)}</div>`
          : '';
      return `
        <div class="item">
          <div class="item-row"><span>${label}</span><span>${fmtKsh(li.lineTotal)}</span></div>
          <div class="item-sub">${li.qty}${unit} &times; ${fmtKsh(li.unitPrice)}</div>
          ${discNote}
        </div>`;
    })
    .join('');
}

/**
 * Opens a popup and prints it — popup must already be open (via a synchronous
 * window.open in the click handler) so browser popup blockers don't kill it
 * once we're past an await elsewhere in the caller.
 */
export function printWalkinReceipt(w: Window | null, order: OrderDetail, company: CompanySettings) {
  if (!w) return;

  const paidTag = order.totals.balanceDue <= 0 ? 'RECEIPT — PAID IN FULL' : 'RECEIPT — BALANCE DUE';
  const companyName = esc((company.companyName || 'GLM Branding').toUpperCase());
  const contactLine = [company.companyAddress, company.companyPhone].filter(Boolean).map(esc).join(' &middot; ');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${order.orderNo}</title>
<style>
  @page { size: ${THERMAL_WIDTH_MM}mm auto; margin: 2mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body {
    width: ${THERMAL_WIDTH_MM - 6}mm; margin: 0 auto; padding: 2mm 1mm;
    font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #111;
  }
  .brand { text-align: center; font-size: 16px; font-weight: 700; letter-spacing: 0.05em; }
  .title { text-align: center; font-size: 10px; margin: 2px 0 6px; letter-spacing: 0.04em; }
  .row { display: flex; justify-content: space-between; }
  hr { border: none; border-top: 1px dashed #111; margin: 4px 0; }
  .item-row { display: flex; justify-content: space-between; font-weight: 700; }
  .item-sub, .disc { font-size: 10px; color: #333; padding-left: 4px; }
  .totals .row { padding: 1px 0; }
  .grand { font-weight: 700; font-size: 13px; border-top: 1px solid #111; margin-top: 3px; padding-top: 3px; }
  .balance { font-weight: 700; }
  .footer { text-align: center; margin-top: 8px; font-size: 10px; }
</style>
</head>
<body>
  <div class="brand">${companyName}</div>
  ${contactLine ? `<div class="title">${contactLine}</div>` : ''}
  <div class="title">${paidTag}</div>
  <div class="row"><span>Order</span><span>${order.orderNo}</span></div>
  <div class="row"><span>Date</span><span>${order.createdDate}</span></div>
  <div class="row"><span>Customer</span><span>${esc(order.customerName || '—')}</span></div>
  ${order.phone ? `<div class="row"><span>Phone</span><span>${esc(order.phone)}</span></div>` : ''}
  <div class="row"><span>Served by</span><span>${esc(order.staff.name)}</span></div>
  <hr />
  ${ticketItemsHtml(order)}
  <hr />
  <div class="totals">
    <div class="row"><span>Subtotal</span><span>${fmtKsh(order.totals.subtotal)}</span></div>
    ${order.totals.orderDiscount > 0 ? `<div class="row"><span>Discount</span><span>-${fmtKsh(order.totals.orderDiscount)}</span></div>` : ''}
    <div class="row grand"><span>TOTAL</span><span>${fmtKsh(order.totals.grandTotal)}</span></div>
  </div>
  <hr />
  ${order.payments
    .map((p) => `<div class="row"><span>${p.date} ${esc(p.method)}</span><span>${fmtKsh(p.amount)}</span></div>`)
    .join('')}
  ${order.totals.balanceDue > 0 ? `<div class="row balance"><span>BALANCE DUE</span><span>${fmtKsh(order.totals.balanceDue)}</span></div>` : ''}
  <div class="footer">Thank you for choosing ${companyName}!</div>
</body>
</html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
  // Courier New is a system font — no webfont load to wait for, print immediately.
  w.onload = () => {
    w.print();
    w.close();
  };
}
