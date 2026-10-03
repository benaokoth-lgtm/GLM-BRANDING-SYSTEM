import { prisma } from '../db';
import { VAT_RATE, buildLineTotal, computeOrderTotals, round2, splitGross } from '@glm/shared';
import type { LineItemInput, NoteType } from '@glm/shared';

// Credit and debit notes. They never edit the original sale or expense: they sit beside it and the ledger posts them.

export class NoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PREFIX: Record<NoteType, string> = { Credit: 'CN', Debit: 'DN', SupplierDebit: 'SDN' };

/** One above the highest number ever issued for this kind of note this year. */
export async function nextNoteNumber(type: NoteType): Promise<string> {
  const prefix = PREFIX[type];
  const year = new Date().getFullYear();
  const rows = await prisma.adjustmentNote.findMany({ where: { number: { startsWith: `${prefix}-${year}-` } }, select: { number: true } });
  let highest = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}-${year}-(\\d+)$`).exec(r.number);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${prefix}-${year}-${String(highest + 1).padStart(3, '0')}`;
}

function toLineInput(li: { itemType: string; serviceId: number | null; materialId: number | null; qty: number; unitPrice: number; discountPct: number; discountAmt: number; heatPressFee: number | null }): LineItemInput {
  return {
    itemType: li.itemType as LineItemInput['itemType'],
    serviceId: li.serviceId,
    materialId: li.materialId,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountAmt: li.discountAmt,
    heatPressFee: li.heatPressFee,
  };
}

export interface NoteLine {
  lineId: number;
  desc: string;
  qty: number; // how many of this line's quantity are credited
  lineQty: number; // the line's full quantity
  unitGross: number; // what one unit actually cost the customer (after discounts), VAT included
  amount: number; // qty × unitGross
  material: boolean;
}

/** What each line of an order is really worth to the customer: line total after the line's own and the order's discount. */
export async function creditableLines(orderId: number): Promise<{ lines: NoteLine[]; total: number; alreadyCredited: number; outstanding: number } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lineItems: { include: { service: true, material: true } }, payments: true, notes: true },
  });
  if (!order) return null;
  const inputs = order.lineItems.map(toLineInput);
  const totals = computeOrderTotals({ lineItems: inputs, orderDiscountPct: order.orderDiscountPct, orderDiscountAmt: order.orderDiscountAmt });
  const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
  const scale = subtotal > 0 ? totals.grandTotal / subtotal : 0;
  const lines: NoteLine[] = order.lineItems.map((li, i) => ({
    lineId: li.id,
    desc: li.material?.name ?? li.service?.name ?? 'Item',
    qty: li.qty,
    lineQty: li.qty,
    unitGross: li.qty > 0 ? round2((buildLineTotal(inputs[i]!) * scale) / li.qty) : 0,
    amount: round2(buildLineTotal(inputs[i]!) * scale),
    material: li.itemType === 'material',
  }));
  const alreadyCredited = round2(order.notes.filter((n) => n.type === 'Credit').reduce((a, n) => a + n.total, 0));
  const debited = order.notes.filter((n) => n.type === 'Debit').reduce((a, n) => a + n.total, 0);
  const paid = order.payments.reduce((a, p) => a + p.amount, 0);
  const outstanding = round2(totals.grandTotal + debited - paid - order.notes.filter((n) => n.type === 'Credit').reduce((a, n) => a + n.receivableAmt, 0));
  return { lines, total: round2(totals.grandTotal), alreadyCredited, outstanding };
}

export interface CreditNoteInput {
  orderId: number;
  reason: string;
  /** Either specific lines (and how many of each)… */
  items?: { lineId: number; qty: number }[];
  /** …or a flat VAT-inclusive amount (a price adjustment, a goodwill discount). */
  amount?: number;
  restock?: boolean;
  refund?: { method: string; amount: number } | null;
  date: string;
  createdBy: string;
}

export async function issueCreditNote(input: CreditNoteInput) {
  if (!input.reason.trim()) throw new NoteError(400, 'A reason is required');
  const info = await creditableLines(input.orderId);
  if (!info) throw new NoteError(404, 'Order not found');
  const order = await prisma.order.findUniqueOrThrow({ where: { id: input.orderId }, include: { corporateClient: true } });
  if (order.kind === 'corporate' && order.status === 'Quote') throw new NoteError(400, 'A quotation is only an offer — nothing has been sold to credit');

  let gross = 0;
  const picked: { lineId: number; desc: string; qty: number; amount: number; material: boolean }[] = [];
  if (input.items && input.items.length) {
    for (const it of input.items) {
      const line = info.lines.find((l) => l.lineId === it.lineId);
      if (!line) throw new NoteError(400, 'A chosen line does not belong to this order');
      if (!(it.qty > 0) || it.qty > line.lineQty + 1e-9) throw new NoteError(400, `Quantity for “${line.desc}” must be between 0 and ${line.lineQty}`);
      const amount = round2(line.unitGross * it.qty);
      picked.push({ lineId: line.lineId, desc: line.desc, qty: it.qty, amount, material: line.material });
      gross += amount;
    }
  } else if (input.amount && input.amount > 0) {
    gross = input.amount;
  } else {
    throw new NoteError(400, 'Choose the items being credited, or enter an amount');
  }
  gross = round2(gross);
  if (gross <= 0) throw new NoteError(400, 'The amount must be greater than zero');
  if (gross > round2(info.total - info.alreadyCredited) + 0.01) {
    throw new NoteError(400, `This order is only worth Ksh ${Math.round(info.total - info.alreadyCredited).toLocaleString('en-KE')} after earlier credit notes`);
  }

  const { net, vat, total } = splitGross(gross, VAT_RATE);
  // What the customer still owes is reduced first; whatever they had already paid becomes a credit owed back to them.
  const receivableAmt = round2(Math.min(total, Math.max(0, info.outstanding)));
  const creditAmt = round2(total - receivableAmt);
  let refundAmt = 0;
  let refundMethod: string | null = null;
  if (input.refund && input.refund.amount > 0) {
    if (input.refund.amount > creditAmt + 0.01) throw new NoteError(400, `Only Ksh ${Math.round(creditAmt).toLocaleString('en-KE')} of this note can be refunded — the rest reduces what the customer still owes`);
    refundAmt = round2(input.refund.amount);
    refundMethod = input.refund.method;
  }

  const note = await prisma.$transaction(async (tx) => {
    // Material lines that came back can go back on the shelf.
    if (input.restock) {
      for (const p of picked.filter((x) => x.material)) {
        const li = await tx.orderLineItem.findUnique({ where: { id: p.lineId } });
        if (li?.materialId) await tx.material.update({ where: { id: li.materialId }, data: { stockQty: { increment: p.qty } } });
      }
    }
    return tx.adjustmentNote.create({
      data: {
        number: await nextNoteNumber('Credit'),
        type: 'Credit',
        date: input.date,
        party: order.customerName || order.corporateClient?.name || 'Customer',
        orderId: order.id,
        reason: input.reason.trim().slice(0, 300),
        itemsJson: picked.length ? JSON.stringify(picked) : null,
        net,
        vat,
        total,
        receivableAmt,
        creditAmt,
        refundAmt,
        refundMethod,
        restocked: !!input.restock && picked.some((p) => p.material),
        createdByName: input.createdBy,
      },
    });
  });
  return note;
}

export interface DebitNoteInput {
  orderId?: number | null;
  party?: string;
  reason: string;
  amount: number; // VAT-inclusive
  incomeAccountId?: number | null;
  date: string;
  createdBy: string;
}

/** A customer debit note: an extra charge (a change request, a delivery fee) added to what a customer owes. */
export async function issueDebitNote(input: DebitNoteInput) {
  if (!input.reason.trim()) throw new NoteError(400, 'A reason is required');
  if (!(input.amount > 0)) throw new NoteError(400, 'The amount must be greater than zero');
  let party = (input.party || '').trim();
  if (input.orderId) {
    const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { corporateClient: true } });
    if (!order) throw new NoteError(404, 'Order not found');
    if (order.kind === 'corporate' && order.status === 'Quote') throw new NoteError(400, 'A quotation is only an offer — invoice it first');
    party = order.customerName || order.corporateClient?.name || party || 'Customer';
  } else {
    throw new NoteError(400, 'Choose the order this extra charge belongs to (so it appears in Accounts Receivable)');
  }
  const { net, vat, total } = splitGross(input.amount, VAT_RATE);
  return prisma.adjustmentNote.create({
    data: {
      number: await nextNoteNumber('Debit'),
      type: 'Debit',
      date: input.date,
      party,
      orderId: input.orderId,
      reason: input.reason.trim().slice(0, 300),
      net,
      vat,
      total,
      incomeAccountId: input.incomeAccountId ?? null,
      createdByName: input.createdBy,
    },
  });
}

export interface SupplierDebitNoteInput {
  expenseId?: number | null;
  supplier?: string;
  reason: string;
  amount: number;
  date: string;
  createdBy: string;
}

/** A debit note to a supplier: goods returned or a billing error, reducing what we owe and the expense it was booked to. */
export async function issueSupplierDebitNote(input: SupplierDebitNoteInput) {
  if (!input.reason.trim()) throw new NoteError(400, 'A reason is required');
  if (!(input.amount > 0)) throw new NoteError(400, 'The amount must be greater than zero');
  let supplier = (input.supplier || '').trim();
  if (input.expenseId) {
    const e = await prisma.expense.findUnique({ where: { id: input.expenseId }, include: { notes: true } });
    if (!e) throw new NoteError(404, 'Expense not found');
    const already = e.notes.filter((n) => n.type === 'SupplierDebit').reduce((a, n) => a + n.total, 0);
    if (input.amount + already > e.amount + 0.01) throw new NoteError(400, `That expense was only Ksh ${Math.round(e.amount).toLocaleString('en-KE')}`);
    supplier = e.supplier || supplier;
  }
  if (!supplier) throw new NoteError(400, 'Enter the supplier this note is for');
  const total = round2(input.amount);
  return prisma.adjustmentNote.create({
    data: {
      number: await nextNoteNumber('SupplierDebit'),
      type: 'SupplierDebit',
      date: input.date,
      party: supplier,
      expenseId: input.expenseId ?? null,
      reason: input.reason.trim().slice(0, 300),
      net: total,
      vat: 0,
      total,
      createdByName: input.createdBy,
    },
  });
}
