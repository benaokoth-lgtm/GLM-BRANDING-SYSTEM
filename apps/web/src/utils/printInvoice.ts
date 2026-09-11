import { fmtDate, fmtKsh } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';

// Creative-agency palette — bold black ink with a pink/orange/teal/purple
// paint-splash accent set, chosen to match GLM Branding's own branding work.
const INK = '#15161a';
const PINK = '#ec2f8f';
const ORANGE = '#f5a623';
const TEAL = '#14b8a6';
const PURPLE = '#7c3aed';
const MUTED = '#767a82';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineItemsRows(order: OrderDetail): string {
  return order.lineItems
    .map((li) => {
      const label = esc(li.serviceName) + (li.materialName ? ' + ' + esc(li.materialName) : '');
      const unit = li.itemType === 'per-metre' ? 'm' : '';
      const pressNote = li.heatPressFee ? `<div class="disc">+ ${fmtKsh(li.heatPressFee)} heat press fee/pc</div>` : '';
      const discNote =
        li.discountPct || li.discountAmt ? `<div class="disc">${li.discountPct}% / -${fmtKsh(li.discountAmt)} off</div>` : '';
      return `
      <tr>
        <td>${label}${pressNote}${discNote}</td>
        <td class="num muted">${li.qty}${unit}</td>
        <td class="num muted">${fmtKsh(li.unitPrice)}</td>
        <td class="num amount">${fmtKsh(li.lineTotal)}</td>
      </tr>`;
    })
    .join('');
}

// A hand-built abstract paint-splash cluster (capsule shapes, not traced from
// any reference) — four rotated "brush stroke" divs per corner in the accent
// palette, echoing the creative-agency look GLM asked for without copying it.
function blobCluster(pos: 'tl' | 'tr' | 'bl' | 'br'): string {
  const flipX = pos === 'tr' || pos === 'br' ? -1 : 1;
  const flipY = pos === 'bl' || pos === 'br' ? -1 : 1;
  const side = pos.includes('t') ? 'top' : 'bottom';
  const hSide = pos.includes('l') ? 'left' : 'right';
  return `
    <div class="blob-cluster" style="${side}:-10mm; ${hSide}:-8mm; transform: scale(${flipX}, ${flipY});">
      <div class="blob" style="width:70px;height:22px;background:${PINK};top:6px;left:0;transform:rotate(-18deg);"></div>
      <div class="blob" style="width:55px;height:18px;background:${TEAL};top:22px;left:30px;transform:rotate(12deg);"></div>
      <div class="blob" style="width:36px;height:16px;background:${ORANGE};top:0;left:58px;transform:rotate(-8deg);"></div>
      <div class="blob" style="width:26px;height:14px;background:${PURPLE};top:34px;left:4px;transform:rotate(30deg);"></div>
    </div>`;
}

// Small generic (non-trademarked) glyphs — no real payment-network logos.
const PAYMENT_ICONS: [string, string][] = [
  ['💵', 'Cash'],
  ['📱', 'M-Pesa'],
  ['🏦', 'Bank Transfer'],
  ['💳', 'Card'],
];

/**
 * Opens a popup and prints it — popup must already be open (via a synchronous
 * window.open in the click handler) so browser popup blockers don't kill it
 * once we're past an await elsewhere in the caller.
 */
export function printCorporateDocument(w: Window | null, order: OrderDetail, company: CompanySettings) {
  if (!w) return;

  const isInvoice = order.status === 'Invoice';
  const docTitle = isInvoice ? 'INVOICE' : 'QUOTATION';
  const isPaid = isInvoice && order.totals.balanceDue <= 0;
  const companyName = esc(company.companyName || 'GLM Branding');
  const brandMark = company.logoDataUrl
    ? `<img class="brand-logo" src="${company.logoDataUrl}" alt="${companyName}" />`
    : `<div class="brand-mark"><div class="ring"></div><div class="dot-a"></div><div class="dot-b"></div></div>`;
  const footerContact = [company.companyAddress, company.companyPhone, company.companyEmail].filter(Boolean).map(esc).join(' &middot; ');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${order.orderNo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;700&family=Barlow+Condensed:wght@400;600;800&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body {
    font-family: 'Barlow', system-ui, sans-serif; color: ${INK}; font-size: 13px;
    margin: 0; position: relative; background: #fff;
  }
  h1, h2 { font-family: 'Barlow Condensed', system-ui, sans-serif; margin: 0; }

  .blob-cluster { position: absolute; width: 100px; height: 60px; overflow: visible; z-index: 0; opacity: 0.9; }
  .blob { position: absolute; border-radius: 999px; }

  .sheet { position: relative; z-index: 1; padding: 6mm 2mm; }

  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .brand-row { display: flex; align-items: center; gap: 10px; }
  .brand-mark { width: 40px; height: 40px; flex: none; position: relative; }
  .brand-mark .ring { position: absolute; inset: 0; border-radius: 50%; border: 9px solid ${TEAL}; }
  .brand-mark .dot-a { position: absolute; width: 16px; height: 16px; border-radius: 50%; background: ${PURPLE}; top: 4px; left: 4px; }
  .brand-mark .dot-b { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: ${ORANGE}; bottom: 2px; right: 2px; }
  .brand-logo { max-width: 90px; max-height: 48px; object-fit: contain; }
  .brand-name { font-family: 'Barlow Condensed', system-ui, sans-serif; font-weight: 800; font-size: 19px; line-height: 1.05; letter-spacing: 0.01em; }
  .brand-sub { font-size: 10px; color: ${MUTED}; margin-top: 2px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 34px; font-weight: 800; letter-spacing: 0.02em; }
  .doc-meta { font-size: 11px; color: ${MUTED}; margin-top: 4px; line-height: 1.6; }

  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
  .party h2 { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
  .party .field { font-size: 12px; margin-bottom: 2px; }
  .party .field .k { color: ${MUTED}; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; display: block; }

  .summary-label { font-weight: 700; font-size: 13px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: ${INK}; color: #fff; }
  th { text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 9px 10px; }
  td { padding: 9px 10px; border-bottom: 1px solid #e5e5e8; font-size: 12px; vertical-align: top; }
  .num { text-align: right; }
  .muted { color: ${MUTED}; }
  .amount { font-weight: 700; }
  .disc { font-size: 10px; color: ${MUTED}; margin-top: 2px; }

  .totals-block { display: flex; justify-content: flex-end; margin-top: 14px; }
  .totals { width: 260px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
  .totals .grand {
    display: flex; justify-content: space-between; align-items: center;
    background: linear-gradient(90deg, ${PINK}, ${ORANGE}); color: #fff;
    font-weight: 800; font-size: 16px; border-radius: 5px; padding: 10px 14px; margin-top: 8px;
  }

  .lower { display: grid; grid-template-columns: 1.1fr 1fr; gap: 24px; margin-top: 28px; align-items: start; }
  .payment-methods h2 { font-size: 12px; font-weight: 700; margin-bottom: 3px; }
  .payment-methods .hint { font-size: 10px; color: ${MUTED}; margin-bottom: 8px; }
  .payment-icons { display: flex; gap: 16px; }
  .payment-icons .icon { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .payment-icons .glyph { font-size: 16px; }

  .status-box { border: 1px solid #e5e5e8; border-radius: 6px; padding: 12px 14px; }
  .status-box .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: ${MUTED}; }
  .status-box .value { font-size: 20px; font-weight: 800; margin-top: 2px; }
  .status-box .value.settled { color: ${TEAL}; }
  .status-box .value.due { color: ${PINK}; }
  .payments-mini { margin-top: 8px; font-size: 10px; color: ${MUTED}; }
  .payments-mini div { display: flex; justify-content: space-between; padding: 1px 0; }

  .footer { margin-top: 40px; text-align: center; }
  .footer .thanks { font-weight: 700; font-size: 14px; }
  .footer .sub { font-size: 10px; color: ${MUTED}; margin-top: 2px; }

  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 120px;
    letter-spacing: 0.08em; color: ${TEAL}; opacity: 0.14; z-index: 999; pointer-events: none; white-space: nowrap;
  }
</style>
</head>
<body>
  ${isPaid ? '<div class="watermark">PAID</div>' : ''}
  ${blobCluster('tl')}
  ${blobCluster('tr')}
  ${blobCluster('bl')}
  ${blobCluster('br')}

  <div class="sheet">
    <div class="header">
      <div class="brand-row">
        ${brandMark}
        <div>
          <div class="brand-name">${companyName}</div>
        </div>
      </div>
      <div class="doc-title">
        <h1>${docTitle}</h1>
        <div class="doc-meta">
          ${isInvoice ? 'Invoice' : 'Quote'} No: #${esc(order.orderNo)}<br/>
          Date: ${fmtDate(order.createdDate)}${isInvoice ? `<br/>Due Date: ${fmtDate(order.dueDate)}` : ''}
        </div>
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <h2>Bill To:</h2>
        <div class="field"><span class="k">Company</span>${esc(order.corporateClient?.name || '—')}</div>
      </div>
      <div class="party">
        <h2>From:</h2>
        <div class="field"><span class="k">Company</span>${companyName}</div>
        ${company.companyAddress ? `<div class="field"><span class="k">Address</span>${esc(company.companyAddress)}</div>` : ''}
        ${company.companyPhone ? `<div class="field"><span class="k">Phone</span>${esc(company.companyPhone)}</div>` : ''}
        ${company.companyEmail ? `<div class="field"><span class="k">Email</span>${esc(company.companyEmail)}</div>` : ''}
        <div class="field"><span class="k">Prepared By</span>${esc(order.staff.name)}</div>
      </div>
    </div>

    <div class="summary-label">${isInvoice ? 'Invoice' : 'Quotation'} Summary</div>
    <table>
      <thead>
        <tr><th>Item Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${lineItemsRows(order)}</tbody>
    </table>

    <div class="totals-block">
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${fmtKsh(order.totals.subtotal)}</span></div>
        ${order.totals.orderDiscount > 0 ? `<div class="row"><span>Discount</span><span>-${fmtKsh(order.totals.orderDiscount)}</span></div>` : ''}
        <div class="grand"><span>${isInvoice ? 'Total Amount' : 'Quote Total'}</span><span>${fmtKsh(order.totals.grandTotal)}</span></div>
      </div>
    </div>

    <div class="lower">
      <div class="payment-methods">
        <h2>Payment Methods</h2>
        <div class="hint">We accept the following on delivery or invoice settlement:</div>
        <div class="payment-icons">
          ${PAYMENT_ICONS.map(([glyph, label]) => `<div class="icon"><span class="glyph">${glyph}</span>${label}</div>`).join('')}
        </div>
      </div>

      ${
        isInvoice
          ? `<div class="status-box">
               <div class="label">${order.totals.balanceDue <= 0 ? 'Payment status' : 'Balance due'}</div>
               <div class="value ${order.totals.balanceDue <= 0 ? 'settled' : 'due'}">${order.totals.balanceDue <= 0 ? 'PAID IN FULL' : fmtKsh(order.totals.balanceDue)}</div>
               ${
                 order.payments.length
                   ? `<div class="payments-mini">${order.payments
                       .map((p) => `<div><span>${fmtDate(p.date)} &middot; ${esc(p.method)}</span><span>${fmtKsh(p.amount)}</span></div>`)
                       .join('')}</div>`
                   : ''
               }
             </div>`
          : `<div class="status-box">
               <div class="label">Status</div>
               <div class="value" style="color:${PURPLE}">Quotation</div>
             </div>`
      }
    </div>

    <div class="footer">
      <div class="thanks">Thank You for Your Business!</div>
      <div class="sub">${companyName}${footerContact ? ' &middot; ' + footerContact : ''}</div>
    </div>
  </div>
</body>
</html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => {
    const ready = w.document.fonts?.ready ?? Promise.resolve();
    ready.then(() => {
      w.print();
      w.close();
    });
  };
}
