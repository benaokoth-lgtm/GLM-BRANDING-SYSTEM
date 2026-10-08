import { fmtDate, fmtKsh, splitVatInclusive } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';

const THERMAL_WIDTH_MM = 80;

/** The two receipts every order prints: one for the customer and one that stays with production. */
export const CUSTOMER_COPY_LABEL = 'CUSTOMER COPY';
export const PRODUCTION_COPY_LABEL = 'PRODUCTION COPY';

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
export function printWalkinReceipt(w: Window | null, order: OrderDetail, company: CompanySettings, copyLabel?: string) {
  if (!w) return;

  const companyName = esc((company.companyName || '').toUpperCase());
  // Same "trading name of ..." disclosure as the A4 invoice/quotation
  // header (see printInvoice.ts) — real legal-name fine print, not a
  // fabricated marketing tagline, in the slot a reference receipt would
  // put its slogan.
  const legalNameLine =
    company.legalName && company.legalName.trim() && company.legalName.trim() !== (company.companyName || '').trim()
      ? `<div class="tagline">Trading name of ${esc(company.legalName.trim())}</div>`
      : '';
  // Both phone numbers and the website print on the receipt (Master Data → Company Info).
  const contactLine = [company.companyAddress, company.companyPhone, company.companyPhone2].filter((v): v is string => !!v && !!v.trim()).map(esc).join(' &middot; ');
  const websiteLine = company.website?.trim() ? esc(company.website.trim()) : '';
  const itemCount = order.lineItems.reduce((a, li) => a + li.qty, 0);
  // Prices are VAT-inclusive throughout this system (see Compliance → VAT) —
  // split the final payable amount back out so the receipt states that
  // plainly instead of leaving VAT status ambiguous on a customer-facing
  // document.
  const { net, vat } = splitVatInclusive(order.totals.grandTotal);

  // Every order prints as two receipts in one job — the customer's copy, then a copy for production — each its own page, so the thermal
  // printer cuts between them. (A single copy can still be asked for with `copyLabel`.)
  const labels = copyLabel ? [copyLabel] : [CUSTOMER_COPY_LABEL, PRODUCTION_COPY_LABEL];
  const copyHtml = (label: string, i: number) => `<div class="${i > 0 ? 'cut' : ''}">
  <div class="center">
    ${company.logoDataUrl ? `<img class="logo" src="${company.logoDataUrl}" alt="" />` : ''}
    <div class="brand">${companyName}</div>
    ${legalNameLine}
  </div>
  ${contactLine ? `<div class="center meta">${contactLine}</div>` : ''}
  ${websiteLine ? `<div class="center meta">${websiteLine}</div>` : ''}
  <div class="center meta">${order.totals.balanceDue <= 0 ? 'RECEIPT — PAID IN FULL' : 'INVOICE — BALANCE DUE'}</div>
  <div class="center copy-label">${esc(label)}</div>
  <hr />
  <div class="row"><span>ORDER NO.</span><span>${esc(order.orderNo)}</span></div>
  <div class="row"><span>DATE</span><span>${fmtDate(order.createdDate)}</span></div>
  ${order.totals.balanceDue > 0 && order.dueDate ? `<div class="row"><span>PAY BY</span><span>${fmtDate(order.dueDate)}</span></div>` : ''}
  <div class="row"><span>CUSTOMER</span><span>${esc(order.customerName || '—')}</span></div>
  ${order.phone ? `<div class="row"><span>PHONE</span><span>${esc(order.phone)}</span></div>` : ''}
  <div class="row"><span>SERVED BY</span><span>${esc(order.staff.name)}</span></div>
  ${order.capturedByName ? `<div class="row"><span>CASHIER</span><span>${esc(order.capturedByName)}</span></div>` : ''}
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
  <div class="keep-note">${order.totals.balanceDue > 0 ? 'PAY THE BALANCE AGAINST THIS ORDER NUMBER' : 'PLEASE KEEP THIS RECEIPT FOR YOUR RECORDS'}</div>
  <div class="keep-note">ITEMS: ${itemCount}</div>
  <div class="barcode-wrap"><svg id="barcode${i}"></svg></div>
  <div class="footer">Thank you for choosing ${companyName}!</div>
  ${websiteLine ? `<div class="footer">${websiteLine}</div>` : ''}
  <div class="footer">${fmtDate(order.createdDate)}</div>
</div>`;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${order.orderNo}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<style>
  @page { size: ${THERMAL_WIDTH_MM}mm auto; margin: 2mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  /* A thermal head burns solid black dots, so thin strokes and grey text break up and fade. Everything is a heavy sans-serif in pure black, with a
     hairline stroke added to thicken the letters — Courier New's fine strokes were what printed faintly. */
  body {
    width: ${THERMAL_WIDTH_MM - 6}mm; margin: 0 auto; padding: 2mm 1mm;
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: 12.5px; font-weight: 700; line-height: 1.25; color: #000;
    -webkit-text-stroke: 0.25px #000;
  }
  .center { text-align: center; }
  .logo { display: block; margin: 0 auto 3px; max-width: 46mm; max-height: 20mm; object-fit: contain; filter: grayscale(1) contrast(1.3); }
  .brand { font-size: 20px; font-weight: 900; letter-spacing: 0.02em; }
  .tagline { font-size: 11.5px; color: #000; margin-top: 1px; }
  .meta { font-size: 11.5px; color: #000; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  hr { border: none; border-top: 2px dashed #000; margin: 5px 0; }
  .item-row { display: flex; justify-content: space-between; gap: 6px; font-weight: 900; overflow-wrap: anywhere; }
  .item-sub, .disc { font-size: 11.5px; color: #000; padding-left: 4px; }
  .totals .row { padding: 1px 0; }
  .grand { font-weight: 900; font-size: 16px; border-top: 2px solid #000; margin-top: 3px; padding-top: 3px; }
  .vat-note { font-size: 11.5px; color: #000; }
  .balance { font-weight: 900; font-size: 14px; }
  .keep-note { font-size: 11.5px; text-align: center; margin-top: 2px; }
  .barcode-wrap { text-align: center; margin: 6px 0; }
  .footer { text-align: center; margin-top: 6px; font-size: 11.5px; }
  .copy-label { font-weight: 900; font-size: 15px; letter-spacing: 0.05em; border: 2px solid #000; padding: 3px 4px; margin: 4px 0; }
  .cut { page-break-before: always; }
</style>
</head>
<body>
${labels.map(copyHtml).join('')}
  <script>
    ${labels.map((_, i) => `try { JsBarcode('#barcode${i}', ${JSON.stringify(order.orderNo)}, { format: 'CODE128', width: 1.6, height: 34, displayValue: true, fontSize: 13, font: 'Arial', fontOptions: 'bold', margin: 0 }); } catch (e) {}`).join('\n    ')}
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
