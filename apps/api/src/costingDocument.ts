import { VAT_RATE, costingJobLabel } from '@glm/shared';

// A saved Job Costing quote as the house quotation: the same document as an invoice or quotation in Finance (orderPdf.ts for the PDF, printInvoice.ts for paper), so it prints,
// emails and goes on WhatsApp exactly like them. It is built to look like an order to those templates — a quotation (status "Quote") with one line for the whole job — but nothing
// here is an order: it carries only what the client may see (the price), never the cost or the margin.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface QuoteRow {
  id: number;
  quoteNo: string;
  createdDate: string;
  validUntil: string;
  clientName: string;
  phone: string;
  staffId: number;
  staffName: string;
  jobType: string;
  summary: string;
  price: number;
  agreedPrice: number | null;
  approval: string;
}

/** What the client is quoted, VAT included: the price agreed with them once that stands (approved, or needing no approval), otherwise the price first quoted. */
export function quotedTotal(q: Pick<QuoteRow, 'price' | 'agreedPrice' | 'approval'>): number {
  const agreed = q.agreedPrice != null && (q.approval === '' || q.approval === 'Approved');
  return r2((agreed ? q.agreedPrice! : q.price) * (1 + VAT_RATE));
}

export function quoteDocument(q: QuoteRow) {
  const total = quotedTotal(q);
  const label = costingJobLabel(q.jobType);
  const what = q.summary.toLowerCase().startsWith(label.toLowerCase()) ? q.summary : `${label}: ${q.summary}`;
  return {
    id: q.id,
    orderNo: q.quoteNo,
    kind: 'corporate' as const,
    channel: 'general' as const,
    customerName: q.clientName,
    phone: q.phone || null,
    corporateClient: null,
    staff: { id: q.staffId, name: q.staffName },
    capturedByName: null,
    createdDate: q.createdDate,
    status: 'Quote' as const,
    stage: 'Order Received' as const,
    dueDate: null,
    validUntil: q.validUntil,
    totals: { subtotal: total, grandTotal: total, orderDiscount: 0, paidTotal: 0, balanceDue: total, paidPct: 0 },
    overdue: false,
    priceApproval: null,
    dtfKind: null,
    businessHeads: [] as string[],
    businessHead: '',
    paymentTiming: null,
    orderDiscountPct: 0,
    orderDiscountAmt: 0,
    lineItems: [{ id: 1, itemType: 'service' as const, serviceId: null, serviceName: what, materialId: null, materialName: null, qty: 1, unitPrice: total, discountPct: 0, discountAmt: 0, heatPressFee: null, artworkAreaSqm: null, lineTotal: total }],
    payments: [] as { id: number; date: string; amount: number; method: string }[],
  };
}
