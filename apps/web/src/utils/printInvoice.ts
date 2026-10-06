import { VAT_RATE, WALK_IN_CLIENT, fmtDate, fmtKsh, splitGross } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';
import { printWalkinReceipt } from './printTicket';

// Invoice / quotation layout: a big navy title with the logo opposite, the company under it, bill-to and document details in
// columns, a table ruled in orange-red, a large TOTAL, and a script "Thank you" beside the terms at the foot of the page.
const NAVY = '#1f2a5e';
const RED = '#e0583a';
const INK = '#111111';
const MUTED = '#5b6075';
const RULE = '#d9dbe3';

// Web fonts are fetched when the document opens (print popup). Where they can't load — an email client, say — the fallbacks keep the
// same condensed-caps feel.
const HEADING_FONT = `'Bebas Neue', Impact, 'Arial Narrow', sans-serif`;
const BODY_FONT = `'Arimo', Arial, Helvetica, sans-serif`;
const SCRIPT_FONT = `'Mr Dafoe', 'Brush Script MT', 'Segoe Script', cursive`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineItemsRows(order: OrderDetail): string {
  return order.lineItems
    .map((li) => {
      const label = [li.serviceName, li.materialName].filter(Boolean).map((s) => esc(s as string)).join(' + ');
      const unit = li.itemType === 'per-metre' ? 'm' : '';
      const pressNote = li.heatPressFee ? `<div class="disc">+ ${fmtKsh(li.heatPressFee)} heat press fee/pc</div>` : '';
      const discParts = [li.discountPct ? `${li.discountPct}%` : '', li.discountAmt ? `-${fmtKsh(li.discountAmt)}` : ''].filter(Boolean);
      const discNote = discParts.length ? `<div class="disc">${discParts.join(' / ')} off</div>` : '';
      return `
      <tr>
        <td class="qty">${li.qty}${unit}</td>
        <td>${label}${pressNote}${discNote}</td>
        <td class="num">${fmtKsh(li.unitPrice)}</td>
        <td class="num">${fmtKsh(li.lineTotal)}</td>
      </tr>`;
    })
    .join('');
}

// Pure HTML string builder — no `window`/DOM dependency — so the exact same
// markup used for the print popup can also be sent as an email body (see
// "Send email" in OrderDetailDialog.tsx) without duplicating the template.
export function buildCorporateDocumentHtml(order: OrderDetail, company: CompanySettings, copyLabel?: string): string {
  // Anything that is not a quotation is an invoice (an older corporate invoice that was paid in full has the status "Order").
  const isInvoice = order.status !== 'Quote';
  // A walk-in order paid in full, sent by email, is a receipt; everything else that is not a quotation is an invoice.
  const isReceipt = order.kind === 'walkin' && order.status === 'Order';
  const docTitle = isReceipt ? 'RECEIPT' : isInvoice ? 'INVOICE' : 'QUOTATION';
  const docWord = isReceipt ? 'RECEIPT' : isInvoice ? 'INVOICE' : 'QUOTE';
  const isPaid = isInvoice && order.totals.balanceDue <= 0;
  const companyName = esc(company.companyName || '');
  const logo = company.logoDataUrl ? `<img class="logo" src="${company.logoDataUrl}" alt="${companyName}" />` : '';
  // The uploaded logo is the registered company's (e.g. "GLM Group Limited"), while companyName is the trading name customers know
  // the business as — this line states the relationship plainly instead of leaving two names side by side.
  const legalNameLine =
    company.legalName && company.legalName.trim() && company.legalName.trim() !== (company.companyName || '').trim()
      ? `<div class="line muted">Trading name of ${esc(company.legalName.trim())}</div>`
      : '';
  // Prices are VAT-inclusive throughout this system (see Compliance → VAT) — split the payable amount back out so the document
  // states VAT plainly rather than leaving it ambiguous.
  // The three figures every invoice and quotation states: the total without VAT, the VAT, and the total with VAT — to the cent, so they add up.
  const { net, vat, total: grand } = splitGross(order.totals.grandTotal, VAT_RATE);
  const ksh2 = (n: number) => 'Ksh ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const client = order.corporateClient;
  const paymentsReceived = order.totals.grandTotal - order.totals.balanceDue;

  const terms = isInvoice
    ? [
        order.dueDate ? `Payment is due by ${fmtDate(order.dueDate)}.` : 'Payment is due on receipt of this invoice.',
        'We accept Cash, M-Pesa, Bank Transfer and Card.',
        'All prices include VAT at 16%.',
      ]
    : ['All prices include VAT at 16%.', 'Production begins once this quotation is accepted — a deposit payment turns it into an invoice.', 'We accept Cash, M-Pesa, Bank Transfer and Card.'];
  // Both phone numbers, then the email; and the website and social pages, each only if it has been entered (Master Data → Company Info).
  const phones = [company.companyPhone, company.companyPhone2].filter((p): p is string => !!p && !!p.trim());
  const contactLine = [...phones, company.companyEmail].filter(Boolean).map((v) => esc(v as string)).join(' &middot; ');
  const phoneLine = phones.length ? `<div class="line">Tel: ${phones.map(esc).join(' &middot; ')}</div>` : '';
  const onlineParts = [company.website?.trim() ? `Web: ${esc(company.website.trim())}` : '', company.facebook?.trim() ? `Facebook: ${esc(company.facebook.trim())}` : '', company.tiktok?.trim() ? `TikTok: ${esc(company.tiktok.trim())}` : ''].filter(Boolean);
  const onlineLine = onlineParts.length ? `<div class="line">${onlineParts.join(' &middot; ')}</div>` : '';

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(order.orderNo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Arimo:wght@400;700&family=Bebas+Neue&family=Mr+Dafoe&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font-family: ${BODY_FONT}; color: ${INK}; font-size: 12.5px; margin: 0; background: #fff; }
  h1, h2, .caps { font-family: ${HEADING_FONT}; font-weight: 400; margin: 0; color: ${NAVY}; letter-spacing: 0.02em; }

  .sheet { position: relative; min-height: 262mm; display: flex; flex-direction: column; padding: 2mm 2mm 0; }

  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .top h1 { font-size: 76px; line-height: 0.95; letter-spacing: 0.015em; }
  .logo { max-width: 120px; max-height: 96px; object-fit: contain; }

  .company { margin-top: 14px; line-height: 1.55; }
  .company .name { font-weight: 700; font-size: 13px; }
  .line { font-size: 12px; }
  .muted { color: ${MUTED}; }

  .info { display: grid; grid-template-columns: 1fr 1fr 1.1fr; gap: 22px; margin-top: 26px; }
  .info h2 { font-size: 21px; margin-bottom: 3px; }
  .info .who { line-height: 1.5; font-size: 12px; }
  .meta { display: grid; grid-template-columns: auto 1fr; column-gap: 14px; row-gap: 3px; align-items: baseline; }
  .meta .k { font-family: ${HEADING_FONT}; color: ${NAVY}; font-size: 21px; line-height: 1.15; letter-spacing: 0.02em; }
  .meta .v { text-align: right; font-size: 12px; }

  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  thead tr { border-top: 2px solid ${RED}; border-bottom: 2px solid ${RED}; }
  th { font-family: ${HEADING_FONT}; font-weight: 400; color: ${NAVY}; font-size: 21px; letter-spacing: 0.02em; padding: 5px 8px 3px; text-align: center; }
  th.l { text-align: left; }
  th.r, td.num { text-align: right; }
  td { padding: 9px 8px; font-size: 12px; vertical-align: top; border-bottom: 1px solid ${RULE}; }
  td.qty { text-align: center; width: 70px; }
  tbody tr:last-child td { border-bottom: 2px solid ${RED}; }
  .disc { font-size: 10px; color: ${MUTED}; margin-top: 2px; }

  .totals { margin: 16px 0 0 auto; width: 340px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; }
  .totals .row.small { font-size: 10.5px; color: ${MUTED}; padding-top: 0; }
  .totals .total { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 8px 0; }
  .totals .total span { font-family: ${HEADING_FONT}; color: ${NAVY}; font-size: 28px; letter-spacing: 0.02em; }
  .totals .total em { font-family: ${BODY_FONT}; font-style: normal; font-size: 11px; color: ${MUTED}; letter-spacing: 0; }
  .totals .due span { color: ${RED}; }
  .status { margin: 8px 8px 0; text-align: right; font-family: ${HEADING_FONT}; font-size: 20px; color: ${NAVY}; letter-spacing: 0.04em; }
  .status.due { color: ${RED}; }
  .payments { margin: 4px 8px 0; font-size: 10.5px; color: ${MUTED}; }
  .payments div { display: flex; justify-content: space-between; padding: 1px 0; }

  .foot { margin-top: auto; padding-top: 40px; display: flex; justify-content: flex-end; align-items: flex-end; gap: 22px; }
  .thanks { font-family: ${SCRIPT_FONT}; color: ${NAVY}; font-size: 58px; line-height: 1; padding-bottom: 6px; white-space: nowrap; }
  .terms { border-left: 2px solid ${NAVY}; padding: 2px 0 2px 16px; width: 290px; }
  .terms h2 { color: ${RED}; font-size: 20px; margin-bottom: 8px; }
  .terms p { margin: 0 0 7px; font-size: 11.5px; line-height: 1.4; }
  .terms .contact { color: ${MUTED}; font-size: 10.5px; }

  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-family: ${HEADING_FONT}; font-size: 190px; letter-spacing: 0.08em; color: ${NAVY}; opacity: 0.07;
    z-index: 0; pointer-events: none; white-space: nowrap;
  }
</style>
</head>
<body>
  ${isPaid ? '<div class="watermark">PAID</div>' : ''}
  <div class="sheet">
    <div class="top">
      <div><h1>${docTitle}</h1>${copyLabel ? `<div class="muted" style="margin-top:4px">${esc(copyLabel)}</div>` : ''}</div>
      ${logo}
    </div>

    <div class="company">
      <div class="name">${companyName}</div>
      ${legalNameLine}
      ${company.companyAddress ? `<div class="line">${esc(company.companyAddress)}</div>` : ''}
      ${phoneLine}
      ${onlineLine}
    </div>

    <div class="info">
      <div>
        <h2>BILL TO</h2>
        <div class="who">
          ${esc(client?.name || order.customerName || (order.kind === 'walkin' ? WALK_IN_CLIENT : '—'))}
          ${client?.phone || order.phone ? `<br/>${esc(client?.phone || order.phone || '')}` : ''}
          ${client?.email ? `<br/>${esc(client.email)}` : ''}
        </div>
      </div>
      <div>
        <h2>PREPARED BY</h2>
        <div class="who">
          ${esc(order.staff.name)}
          ${contactLine ? `<br/>${contactLine}` : ''}
        </div>
      </div>
      <div class="meta">
        <span class="k">${docWord} #</span><span class="v">${esc(order.orderNo)}</span>
        <span class="k">${docWord} DATE</span><span class="v">${fmtDate(order.createdDate)}</span>
        ${isInvoice && order.dueDate ? `<span class="k">DUE DATE</span><span class="v">${fmtDate(order.dueDate)}</span>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>QTY</th><th class="l">DESCRIPTION</th><th class="r">UNIT PRICE</th><th class="r">AMOUNT</th></tr>
      </thead>
      <tbody>${lineItemsRows(order)}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal (Incl. VAT)</span><span>${ksh2(order.totals.subtotal)}</span></div>
      ${order.totals.orderDiscount > 0 ? `<div class="row"><span>Discount</span><span>-${ksh2(order.totals.orderDiscount)}</span></div>` : ''}
      <div class="row small"><span>Total excluding VAT</span><span>${ksh2(net)}</span></div>
      <div class="row"><span>VAT @${Math.round(VAT_RATE * 100)}%</span><span>${ksh2(vat)}</span></div>
      <div class="total"><span>${isInvoice ? 'TOTAL DUE' : 'TOTAL'}</span><span>${ksh2(grand)}</span></div>
      ${
        isInvoice
          ? `${
              order.payments.length
                ? `<div class="payments">${order.payments
                    .map((p) => `<div><span>Paid ${fmtDate(p.date)} &middot; ${esc(p.method)}</span><span>${fmtKsh(p.amount)}</span></div>`)
                    .join('')}</div>`
                : ''
            }
            ${order.totals.balanceDue > 0.009 ? `<div class="total due"><span>BALANCE DUE</span><span>${ksh2(order.totals.balanceDue)}</span></div>` : ''}
            <div class="status ${isPaid ? '' : 'due'}">${isPaid ? 'PAID IN FULL' : order.totals.balanceDue > 0.009 && paymentsReceived <= 0.009 ? 'PAYMENT DUE' : ''}</div>`
          : ''
      }
    </div>

    <div class="foot">
      <div class="thanks">Thank you</div>
      <div class="terms">
        <h2>TERMS &amp; CONDITIONS</h2>
        ${terms.map((t) => `<p>${esc(t)}</p>`).join('')}
        ${contactLine ? `<p class="contact">${contactLine}</p>` : ''}
        ${onlineParts.length ? `<p class="contact">${onlineParts.join('<br/>')}</p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Opens a popup and prints it — popup must already be open (via a synchronous
 * window.open in the click handler) so browser popup blockers don't kill it
 * once we're past an await elsewhere in the caller.
 */
export function printCorporateDocument(w: Window | null, order: OrderDetail, company: CompanySettings, copyLabel?: string) {
  if (!w) return;
  const html = buildCorporateDocumentHtml(order, company, copyLabel);
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

/**
 * Prints an order the way it should look on paper: an invoice or a quotation — whoever it is for, walk-in or corporate — is the A4 document in the
 * house layout (navy title, logo, ruled table, TOTAL, Thank you and terms); only a walk-in order that is paid in full is a till receipt, printed on the
 * 80 mm thermal printer.
 */
export function printOrderDocument(w: Window | null, order: OrderDetail, company: CompanySettings, copyLabel?: string) {
  if (order.kind === 'walkin' && order.status === 'Order') printWalkinReceipt(w, order, company, copyLabel);
  else printCorporateDocument(w, order, company, copyLabel);
}
