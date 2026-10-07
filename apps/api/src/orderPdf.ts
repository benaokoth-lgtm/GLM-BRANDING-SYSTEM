// The A4 invoice / quotation / receipt as a real PDF file, for sending by email as an attachment. It follows the layout of the printed document (see
// buildCorporateDocumentHtml in apps/web/src/utils/printInvoice.ts): a navy title with the logo opposite, the company, bill-to / prepared-by / document
// details, a table ruled in orange-red, the totals, and the thank-you and terms at the foot. Built with pdf-lib, which is pure JavaScript with the standard
// fonts inside it, so it bundles into the single server.js and needs no browser or system fonts.
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { VAT_RATE, WALK_IN_CLIENT, fmtDate, fmtKsh, splitGross } from '@glm/shared';

export interface PdfOrder {
  orderNo: string;
  kind: string;
  status: string;
  createdDate: string;
  dueDate: string | null;
  customerName: string | null;
  phone: string | null;
  corporateClient: { name: string; phone: string | null; email: string | null } | null;
  staff: { name: string };
  lineItems: { qty: number; itemType: string; serviceName: string | null; materialName: string | null; unitPrice: number; lineTotal: number; heatPressFee: number | null; discountPct: number; discountAmt: number }[];
  totals: { subtotal: number; orderDiscount: number; grandTotal: number; balanceDue: number };
  payments: { date: string; method: string; amount: number }[];
}

export interface PdfCompany {
  companyName: string;
  legalName: string;
  companyAddress: string;
  companyPhone: string;
  companyPhone2: string;
  companyEmail: string;
  website: string;
  facebook: string;
  tiktok: string;
  logoDataUrl: string | null;
}

/** What the document is called: a quotation, an invoice, or (a walk-in order paid in full) a receipt. */
export function documentKind(order: Pick<PdfOrder, 'kind' | 'status'>) {
  const isInvoice = order.status !== 'Quote';
  const isReceipt = order.kind === 'walkin' && order.status === 'Order';
  return {
    isInvoice,
    isReceipt,
    title: isReceipt ? 'RECEIPT' : isInvoice ? 'INVOICE' : 'QUOTATION',
    word: isReceipt ? 'RECEIPT' : isInvoice ? 'INVOICE' : 'QUOTE',
    /** For file names and email wording. */
    label: isReceipt ? 'Receipt' : isInvoice ? 'Invoice' : 'Quotation',
  };
}

const NAVY = rgb(31 / 255, 42 / 255, 94 / 255);
const RED = rgb(224 / 255, 88 / 255, 58 / 255);
const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(91 / 255, 96 / 255, 117 / 255);
const RULE = rgb(217 / 255, 219 / 255, 227 / 255);

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40; // margin
const RIGHT = PAGE_W - M;

/** The standard fonts only draw Western-European characters: keep accents' base letters, and show anything else as "?" instead of failing. */
const clean = (s: string) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e -ÿ–—•]/g, '?');

const ksh2 = (n: number) => 'Ksh ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const trial = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(trial, size) <= maxW || !line) line = trial;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function dataUrlBytes(url: string | null): { bytes: Uint8Array; type: 'png' | 'jpg' } | null {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url ?? '');
  if (!m) return null;
  return { bytes: Uint8Array.from(Buffer.from(m[2]!.replace(/\s/g, ''), 'base64')), type: m[1]!.toLowerCase() === 'png' ? 'png' : 'jpg' };
}

export async function buildOrderPdf(order: PdfOrder, company: PdfCompany): Promise<Buffer> {
  const kind = documentKind(order);
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  doc.setTitle(`${kind.label} ${order.orderNo}`);
  doc.setCreator(clean(company.companyName || 'GLM Branding'));
  doc.setProducer('GLM POS');

  let logo: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  const img = dataUrlBytes(company.logoDataUrl);
  if (img) {
    try {
      logo = img.type === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    } catch {
      logo = null; // a logo that will not embed is left off, not a reason to fail the document
    }
  }

  const isPaid = kind.isInvoice && order.totals.balanceDue <= 0.009;
  const client = order.corporateClient;
  const paymentsReceived = order.totals.grandTotal - order.totals.balanceDue;
  const { net, vat, total: grand } = splitGross(order.totals.grandTotal, VAT_RATE);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  const text = (t: string, x: number, y: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const size = o.size ?? 10;
    const font = o.font ?? reg;
    const s = clean(t);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: o.right ? x - w : x, y, size, font, color: o.color ?? INK });
  };
  const hline = (y: number, x1 = M, x2 = RIGHT, thickness = 0.6, color = RULE) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  const watermark = () => {
    if (!isPaid) return;
    page.drawText('PAID', { x: 150, y: 300, size: 170, font: bold, color: NAVY, opacity: 0.06, rotate: degrees(32) });
  };
  watermark();

  // ── Title and logo ──
  let y = PAGE_H - M;
  text(kind.title, M, y - 34, { size: 40, font: bold, color: NAVY });
  if (logo) {
    const box = { w: 110, h: 80 };
    const scale = Math.min(box.w / logo.width, box.h / logo.height, 1);
    page.drawImage(logo, { x: RIGHT - logo.width * scale, y: PAGE_H - M - logo.height * scale, width: logo.width * scale, height: logo.height * scale });
  }
  y -= 62;

  // ── Company ──
  text(company.companyName, M, y, { size: 11, font: bold });
  y -= 13;
  const legal = company.legalName?.trim();
  if (legal && legal !== (company.companyName || '').trim()) {
    text(`Trading name of ${legal}`, M, y, { size: 9, color: MUTED });
    y -= 12;
  }
  if (company.companyAddress) {
    for (const l of wrap(company.companyAddress, reg, 9.5, 300)) {
      text(l, M, y, { size: 9.5 });
      y -= 12;
    }
  }
  const phones = [company.companyPhone, company.companyPhone2].filter((p) => !!p && p.trim());
  if (phones.length) {
    text(`Tel: ${phones.join('  |  ')}`, M, y, { size: 9.5 });
    y -= 12;
  }
  const online = [company.website?.trim() ? `Web: ${company.website.trim()}` : '', company.facebook?.trim() ? `Facebook: ${company.facebook.trim()}` : '', company.tiktok?.trim() ? `TikTok: ${company.tiktok.trim()}` : ''].filter(Boolean);
  if (online.length) {
    text(online.join('  |  '), M, y, { size: 9.5 });
    y -= 12;
  }
  y -= 14;

  // ── Bill to / prepared by / document details ──
  const colX = [M, M + 175, M + 340];
  const topInfo = y;
  text('BILL TO', colX[0]!, y, { size: 13, font: bold, color: NAVY });
  text('PREPARED BY', colX[1]!, y, { size: 13, font: bold, color: NAVY });
  y -= 15;
  let yb = y;
  const billTo = [client?.name || order.customerName || (order.kind === 'walkin' ? WALK_IN_CLIENT : '-'), client?.phone || order.phone || '', client?.email || ''].filter(Boolean);
  for (const l of billTo) for (const w of wrap(l, reg, 10, 160)) {
    text(w, colX[0]!, yb, { size: 10 });
    yb -= 12.5;
  }
  let yp = y;
  const contactLine = [...phones, company.companyEmail].filter(Boolean).join(' | ');
  for (const l of [order.staff.name, ...(contactLine ? wrap(contactLine, reg, 9, 150) : [])]) {
    text(l, colX[1]!, yp, { size: l === order.staff.name ? 10 : 9, color: l === order.staff.name ? INK : MUTED });
    yp -= 12.5;
  }
  const meta: [string, string][] = [[`${kind.word} #`, order.orderNo], [`${kind.word} DATE`, fmtDate(order.createdDate)]];
  if (kind.isInvoice && order.dueDate) meta.push(['DUE DATE', fmtDate(order.dueDate)]);
  let ym = topInfo;
  for (const [k, v] of meta) {
    text(k, colX[2]!, ym, { size: 11.5, font: bold, color: NAVY });
    text(v, RIGHT, ym, { size: 10, right: true });
    ym -= 15;
  }
  y = Math.min(yb, yp, ym) - 14;

  // ── Table ──
  const colQty = M + 8;
  const colDesc = M + 62;
  const colUnit = RIGHT - 100;
  const descW = colUnit - 70 - colDesc;
  const drawHead = () => {
    page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 1.5, color: RED });
    text('QTY', colQty, y - 15, { size: 11, font: bold, color: NAVY });
    text('DESCRIPTION', colDesc, y - 15, { size: 11, font: bold, color: NAVY });
    text('UNIT PRICE', colUnit, y - 15, { size: 11, font: bold, color: NAVY, right: true });
    text('AMOUNT', RIGHT - 8, y - 15, { size: 11, font: bold, color: NAVY, right: true });
    page.drawLine({ start: { x: M, y: y - 22 }, end: { x: RIGHT, y: y - 22 }, thickness: 1.5, color: RED });
    y -= 22;
  };
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    watermark();
    y = PAGE_H - M;
  };
  drawHead();
  for (const li of order.lineItems) {
    const label = [li.serviceName, li.materialName].filter(Boolean).join(' + ') || 'Item';
    const notes: string[] = [];
    if (li.heatPressFee) notes.push(`+ ${fmtKsh(li.heatPressFee)} heat press fee/pc`);
    const disc = [li.discountPct ? `${li.discountPct}%` : '', li.discountAmt ? `-${fmtKsh(li.discountAmt)}` : ''].filter(Boolean);
    if (disc.length) notes.push(`${disc.join(' / ')} off`);
    const descLines = wrap(label, reg, 10, descW);
    const rowH = 10 + descLines.length * 12.5 + notes.length * 10.5 + 6;
    if (y - rowH < M + 40) {
      newPage();
      drawHead();
    }
    let ry = y - 16;
    text(`${li.qty}${li.itemType === 'per-metre' ? 'm' : ''}`, colQty + 6, ry, { size: 10 });
    text(fmtKsh(li.unitPrice), colUnit, ry, { size: 10, right: true });
    text(fmtKsh(li.lineTotal), RIGHT - 8, ry, { size: 10, right: true });
    for (const l of descLines) {
      text(l, colDesc, ry, { size: 10 });
      ry -= 12.5;
    }
    ry += 12.5 - 10.5;
    for (const n of notes) {
      ry -= 10.5;
      text(n, colDesc, ry + 1, { size: 8, color: MUTED });
    }
    y -= rowH;
    hline(y);
  }
  page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 1.5, color: RED });
  y -= 10;

  // ── Totals ── (kept together: a new page if they would not fit)
  const payRows = kind.isInvoice ? order.payments.length : 0;
  const totalsH = 150 + payRows * 12;
  if (y - totalsH < M + 150) {
    newPage();
    y -= 4;
  }
  const tx = RIGHT - 250;
  const row = (label: string, value: string, o: { size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    y -= 14;
    text(label, tx + 8, y, { size: o.size ?? 10, color: o.color });
    text(value, RIGHT - 8, y, { size: o.size ?? 10, right: true, color: o.color });
  };
  row('Subtotal (Incl. VAT)', ksh2(order.totals.subtotal));
  if (order.totals.orderDiscount > 0) row('Discount', '-' + ksh2(order.totals.orderDiscount));
  row('Total excluding VAT', ksh2(net), { size: 9, color: MUTED });
  row(`VAT @${Math.round(VAT_RATE * 100)}%`, ksh2(vat));
  y -= 8;
  y -= 18;
  text(kind.isInvoice ? 'TOTAL DUE' : 'TOTAL', tx + 8, y, { size: 18, font: bold, color: NAVY });
  text(ksh2(grand), RIGHT - 8, y, { size: 13, font: bold, right: true, color: NAVY });
  if (kind.isInvoice) {
    for (const p of order.payments) {
      y -= 12;
      text(`Paid ${fmtDate(p.date)} - ${p.method}`, tx + 8, y, { size: 9, color: MUTED });
      text(fmtKsh(p.amount), RIGHT - 8, y, { size: 9, color: MUTED, right: true });
    }
    if (order.totals.balanceDue > 0.009) {
      y -= 22;
      text('BALANCE DUE', tx + 8, y, { size: 16, font: bold, color: RED });
      text(ksh2(order.totals.balanceDue), RIGHT - 8, y, { size: 13, font: bold, right: true, color: RED });
    }
    const statusText = isPaid ? 'PAID IN FULL' : order.totals.balanceDue > 0.009 && paymentsReceived <= 0.009 ? 'PAYMENT DUE' : '';
    if (statusText) {
      y -= 20;
      text(statusText, RIGHT - 8, y, { size: 15, font: bold, right: true, color: isPaid ? NAVY : RED });
    }
  }

  // ── Thank you and terms, at the foot of the last page ──
  const terms = kind.isInvoice
    ? [order.dueDate ? `Payment is due by ${fmtDate(order.dueDate)}.` : 'Payment is due on receipt of this invoice.', 'We accept Cash, M-Pesa, Bank Transfer and Card.', 'All prices include VAT at 16%.']
    : ['All prices include VAT at 16%.', 'Production begins once this quotation is accepted - a deposit payment turns it into an invoice.', 'We accept Cash, M-Pesa, Bank Transfer and Card.'];
  const termsW = 250;
  const termLines = terms.flatMap((t) => [...wrap(t, reg, 9.5, termsW - 16), '']);
  const footH = 36 + termLines.length * 12;
  let fy = M + footH;
  if (y - 24 < fy) {
    newPage();
    fy = M + footH;
  }
  page.drawLine({ start: { x: RIGHT - termsW, y: fy + 4 }, end: { x: RIGHT - termsW, y: M }, thickness: 1.5, color: NAVY });
  text('TERMS & CONDITIONS', RIGHT - termsW + 12, fy - 10, { size: 12, font: bold, color: RED });
  let ty = fy - 26;
  for (const l of termLines) {
    if (l) text(l, RIGHT - termsW + 12, ty, { size: 9.5 });
    ty -= l ? 12 : 5;
  }
  text('Thank you', M, M + 8, { size: 30, font: boldItalic, color: NAVY });

  return Buffer.from(await doc.save());
}
