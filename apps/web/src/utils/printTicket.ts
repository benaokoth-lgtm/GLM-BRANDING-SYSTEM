import { fmtDate, fmtKsh, splitVatInclusive } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';

const THERMAL_WIDTH_MM = 80;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ticketItemsHtml(order: OrderDetail): string {
  return order.lineItems
    .map((li) => {
      const label = esc([li.serviceName, li.materialName].filter(Boolean).join(' + ').toUpperCase());
      const unit = li.itemType === 'per-metre' ? 'm' : '';
      const pressNote = li.heatPressFee ? `<div class="disc">+ ${fmtKsh(li.heatPressFee)} heat press fee/pc</div>` : '';
      const discNote =
        li.discountPct || li.discountAmt
          ? `<div class="disc">disc ${li.discountPct}% / ${fmtKsh(li.discountAmt)}</div>`
          : '';
      return `
        <div class="item">
          <div class="item-row"><span>${label}</span><span>${fmtKsh(li.lineTotal)}</span></div>
          <div class="item-sub">${li.qty}${unit} &times; ${fmtKsh(li.unitPrice)}</div>
          ${pressNote}
          ${discNote}
        </div>`;
    })
    .join('');
}

/**
 * Opens a popup and prints it — popup must already be open (via a synchronous
 * window.open in the click handler) so browser popup blockers don't kill it
 * once we're past an await elsewhere in the caller.
 *
 * Laid out to match a standard UK supermarket-style thermal receipt (bold
 * centred brand block, dashed section rules, itemised purchases, a totals
 * block, a keep-this-copy note + item count, a scannable barcode, and a
 * closing tagline) — every field on it is real GLM data (order/customer/
 * staff/payment records), nothing invented to fill a slot the reference
 * had (till/terminal/card-authorisation numbers) that this system doesn't
 * actually track.
 */
export function printWalkinReceipt(w: Window | null, order: OrderDetail, company: CompanySettings) {
  if (!w) return;

  const companyName = esc((company.companyName || 'GLM Branding').toUpperCase());
  // Same "trading name of ..." disclosure as the A4 invoice/quotation
  // header (see printInvoice.ts) — real legal-name fine print, not a
  // fabricated marketing tagline, in the slot a reference receipt would
  // put its slogan.
  const legalNameLine =
    company.legalName && company.legalName.trim() && company.legalName.trim() !== (company.companyName || '').trim()
      ? `<div class="tagline">Trading name of ${esc(company.legalName.trim())}</div>`
      : '';
  const contactLine = [company.companyAddress, company.companyPhone].filter(Boolean).map(esc).join(' &middot; ');
  const itemCount = order.lineItems.reduce((a, li) => a + li.qty, 0);
  // Prices are VAT-inclusive throughout this system (see Compliance → VAT) —
  // split the final payable amount back out so the receipt states that
  // plainly instead of leaving VAT status ambiguous on a customer-facing
  // document.
  const { net, vat } = splitVatInclusive(order.totals.grandTotal);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${order.orderNo}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<style>
  @page { size: ${THERMAL_WIDTH_MM}mm auto; margin: 2mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body {
    width: ${THERMAL_WIDTH_MM - 6}mm; margin: 0 auto; padding: 2mm 1mm;
    font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #111;
  }
  .center { text-align: center; }
  .brand { font-size: 18px; font-weight: 700; letter-spacing: 0.03em; }
  .tagline { font-size: 10px; color: #333; margin-top: 1px; }
  .meta { font-size: 10px; color: #333; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  hr { border: none; border-top: 1px dashed #111; margin: 4px 0; }
  .item-row { display: flex; justify-content: space-between; font-weight: 700; }
  .item-sub, .disc { font-size: 10px; color: #333; padding-left: 4px; }
  .totals .row { padding: 1px 0; }
  .grand { font-weight: 700; font-size: 14px; border-top: 1px solid #111; margin-top: 3px; padding-top: 3px; }
  .vat-note { font-size: 10px; color: #333; }
  .balance { font-weight: 700; }
  .keep-note { font-size: 10px; text-align: center; margin-top: 2px; }
  .barcode-wrap { text-align: center; margin: 6px 0; }
  .footer { text-align: center; margin-top: 6px; font-size: 10px; }
</style>
</head>
<body>
  <div class="center">
    <div class="brand">${companyName}</div>
    ${legalNameLine}
  </div>
  ${contactLine ? `<div class="center meta">${contactLine}</div>` : ''}
  <div class="center meta">${order.totals.balanceDue <= 0 ? 'RECEIPT — PAID IN FULL' : 'RECEIPT — BALANCE DUE'}</div>
  <hr />
  <div class="row"><span>ORDER NO.</span><span>${esc(order.orderNo)}</span></div>
  <div class="row"><span>DATE</span><span>${fmtDate(order.createdDate)}</span></div>
  <div class="row"><span>CUSTOMER</span><span>${esc(order.customerName || '—')}</span></div>
  ${order.phone ? `<div class="row"><span>PHONE</span><span>${esc(order.phone)}</span></div>` : ''}
  <div class="row"><span>SERVED BY</span><span>${esc(order.staff.name)}</span></div>
  <hr />
  ${ticketItemsHtml(order)}
  <hr />
  <div class="totals">
    <div class="row"><span>SUBTOTAL</span><span>${fmtKsh(order.totals.subtotal)}</span></div>
    ${order.totals.orderDiscount > 0 ? `<div class="row"><span>DISCOUNT</span><span>-${fmtKsh(order.totals.orderDiscount)}</span></div>` : ''}
    <div class="row grand"><span>TOTAL</span><span>${fmtKsh(order.totals.grandTotal)}</span></div>
    <div class="row vat-note"><span>Incl. VAT (16%)</span><span>${fmtKsh(vat)}</span></div>
    <div class="row vat-note"><span>Net amount</span><span>${fmtKsh(net)}</span></div>
  </div>
  <hr />
  ${order.payments
    .map((p) => `<div class="row"><span>${fmtDate(p.date)} ${esc(p.method).toUpperCase()}</span><span>${fmtKsh(p.amount)}</span></div>`)
    .join('')}
  ${order.totals.balanceDue > 0 ? `<div class="row balance"><span>BALANCE DUE</span><span>${fmtKsh(order.totals.balanceDue)}</span></div>` : ''}
  <hr />
  <div class="keep-note">PLEASE KEEP THIS RECEIPT FOR YOUR RECORDS</div>
  <div class="keep-note">ITEMS: ${itemCount}</div>
  <div class="barcode-wrap"><svg id="barcode"></svg></div>
  <div class="footer">Thank you for choosing ${companyName}!</div>
  <div class="footer">${fmtDate(order.createdDate)}</div>
  <script>
    try {
      JsBarcode('#barcode', ${JSON.stringify(order.orderNo)}, { format: 'CODE128', width: 1.4, height: 34, displayValue: true, fontSize: 10, margin: 0 });
    } catch (e) {}
  </script>
</body>
</html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
  // Courier New is a system font (no webfont wait needed), but the barcode
  // script is loaded from a CDN — give it a moment to arrive and render
  // before printing rather than racing it.
  w.onload = () => {
    setTimeout(() => {
      w.print();
      w.close();
    }, 300);
  };
}
