import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { ACCOUNT_TYPES, ACCT, PAYOUT_METHODS, SYSTEM_ACCOUNT_CODES, DEPRECIATION_METHODS, matchPayment, suggestionsFor, round2, todayStr } from '@glm/shared';
import { ensureChartOnce, validateAccountChoice } from '../accounting/chart';
import { loadLedger, naturalBalance, sumByAccount } from '../accounting/ledger';
import { buildAccountLedger, buildBalanceSheet, buildCashFlowStatement, buildPayablesAging, buildProfitLoss, buildReceivablesAging, buildTrialBalance } from '../accounting/reports';
import { reconcile } from '../accounting/reconcile';
import { creditableLines, issueCreditNote, issueDebitNote, issueSupplierDebitNote, NoteError } from '../accounting/notes';
import { depreciationSchedule, runDepreciationOnce } from '../accounting/depreciation';
import { applyReceiptToOrder, autoMatch, importStatement, openTargets } from '../accounting/mpesaMatching';
import { PaymentError } from './orders';

export const accountingRouter = Router();
accountingRouter.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Every request first makes sure the chart exists and depreciation is caught up, so any screen opens on current books.
async function prepare(_req: Request, _res: Response, next: NextFunction) {
  await ensureChartOnce();
  await runDepreciationOnce();
  next();
}

// M-Pesa matching is also open to anyone who can manage payments (a cashier matching a customer's payment).
const mpesaAccess = [requirePermission('canAccessAccounting', 'canManagePayments'), prepare];
const accountingOnly = [requirePermission('canAccessAccounting'), prepare];

function range(req: Request): { from: string; to: string } | null {
  const from = req.query.from;
  const to = req.query.to;
  return isDate(from) && isDate(to) ? { from, to } : null;
}
const asOfOf = (req: Request) => (isDate(req.query.asOf) ? (req.query.asOf as string) : todayStr());

// ── Chart of accounts ─────────────────────────────────────────────────────
accountingRouter.get('/accounts', ...accountingOnly, async (req, res) => {
  const asOf = asOfOf(req);
  const ledger = await loadLedger();
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const accounts = await prisma.account.findMany({ orderBy: { code: 'asc' } });
  res.json(accounts.map((a) => ({ ...a, balance: naturalBalance(a.type, sums.get(a.id)) })));
});

const accountSchema = z.object({
  code: z.string().regex(/^\d{3,6}$/, 'Account code must be 3 to 6 digits'),
  name: z.string().trim().min(1).max(100),
  type: z.enum(ACCOUNT_TYPES as [string, ...string[]]),
  subtype: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
});

accountingRouter.post('/accounts', ...accountingOnly, async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (await prisma.account.findUnique({ where: { code: parsed.data.code } })) return res.status(400).json({ error: 'That account code is already in use' });
  const acc = await prisma.account.create({ data: { ...parsed.data, subtype: parsed.data.subtype ?? '', description: parsed.data.description ?? '' } });
  res.status(201).json(acc);
});

accountingRouter.put('/accounts/:id', ...accountingOnly, async (req, res) => {
  const acc = await prisma.account.findUnique({ where: { id: Number(req.params.id) } });
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const parsed = z
    .object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(300).optional(), active: z.boolean().optional(), type: z.enum(ACCOUNT_TYPES as [string, ...string[]]).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (acc.system && (parsed.data.type && parsed.data.type !== acc.type)) return res.status(400).json({ error: 'A built-in account cannot change type' });
  if (acc.system && parsed.data.active === false) return res.status(400).json({ error: 'A built-in account cannot be deactivated' });
  res.json(await prisma.account.update({ where: { id: acc.id }, data: parsed.data }));
});

// ── Linking expenses and incomes to accounts ──────────────────────────────
accountingRouter.get('/links', ...accountingOnly, async (_req, res) => {
  const [heads, services, materials] = await Promise.all([
    prisma.expenseHead.findMany({ orderBy: { name: 'asc' }, include: { account: true } }),
    prisma.service.findMany({ orderBy: { name: 'asc' }, include: { account: true } }),
    prisma.material.findMany({ orderBy: { name: 'asc' }, include: { account: true } }),
  ]);
  const merch = await prisma.account.findUnique({ where: { code: ACCT.merchandiseIncome } });
  res.json({
    expenseHeads: heads.map((h) => ({ id: h.id, name: h.name, accountId: h.accountId, account: h.account ? `${h.account.code} ${h.account.name}` : null })),
    services: services.map((s) => ({ id: s.id, name: s.name, accountId: s.accountId, account: s.account ? `${s.account.code} ${s.account.name}` : null })),
    materials: materials.map((m) => ({ id: m.id, name: m.name, accountId: m.accountId, account: m.account ? `${m.account.code} ${m.account.name}` : merch ? `${merch.code} ${merch.name} (default)` : null })),
  });
});

const linkSchema = z.object({ accountId: z.number().int().nullable() });
async function setLink(req: Request, res: Response, kind: 'expenseHead' | 'service' | 'material') {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose an account' });
  const id = Number(req.params.id);
  try {
    const accountId = await validateAccountChoice(parsed.data.accountId, kind === 'expenseHead' ? 'Expense' : 'Income');
    if (kind === 'expenseHead') {
      if (!accountId) return res.status(400).json({ error: 'An expense head must be linked to an Expense account' });
      await prisma.expenseHead.update({ where: { id }, data: { accountId } });
    } else if (kind === 'service') {
      if (!accountId) return res.status(400).json({ error: 'A service must be linked to an Income account' });
      await prisma.service.update({ where: { id }, data: { accountId } });
    } else {
      await prisma.material.update({ where: { id }, data: { accountId } });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Could not link' });
  }
}
accountingRouter.put('/links/expense-head/:id', ...accountingOnly, (req, res) => setLink(req, res, 'expenseHead'));
accountingRouter.put('/links/service/:id', ...accountingOnly, (req, res) => setLink(req, res, 'service'));
accountingRouter.put('/links/material/:id', ...accountingOnly, (req, res) => setLink(req, res, 'material'));

// ── Journals (what has no operational home) ───────────────────────────────
const JOURNAL_SOURCES = ['Manual', 'Opening', 'Capital', 'Drawings', 'BankDeposit', 'TaxPayment'] as const;

accountingRouter.get('/journals', ...accountingOnly, async (req, res) => {
  const r = range(req);
  const entries = await prisma.journalEntry.findMany({
    where: r ? { date: { gte: r.from, lte: r.to } } : undefined,
    include: { lines: { include: { account: true } } },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  });
  res.json(entries.map((e) => ({ ...e, lines: e.lines.map((l) => ({ id: l.id, accountId: l.accountId, account: `${l.account.code} ${l.account.name}`, debit: l.debit, credit: l.credit, memo: l.memo })) })));
});

const journalSchema = z.object({
  date: dateStr,
  memo: z.string().trim().min(1).max(200),
  source: z.enum(JOURNAL_SOURCES).default('Manual'),
  lines: z.array(z.object({ accountId: z.number().int(), debit: z.number().min(0).default(0), credit: z.number().min(0).default(0), memo: z.string().max(200).optional() })).min(2),
});

accountingRouter.post('/journals', ...accountingOnly, async (req, res) => {
  const parsed = journalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const lines = d.lines.filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) return res.status(400).json({ error: 'A journal needs at least two lines with an amount' });
  if (lines.some((l) => l.debit > 0 && l.credit > 0)) return res.status(400).json({ error: 'A line is either a debit or a credit, not both' });
  const debit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const credit = round2(lines.reduce((a, l) => a + l.credit, 0));
  if (Math.abs(debit - credit) > 0.005) return res.status(400).json({ error: `Debits (${debit}) and credits (${credit}) must be equal` });

  const accounts = await prisma.account.findMany({ where: { id: { in: lines.map((l) => l.accountId) } } });
  if (accounts.length !== new Set(lines.map((l) => l.accountId)).size) return res.status(400).json({ error: 'A chosen account does not exist' });
  if (accounts.some((a) => !a.active)) return res.status(400).json({ error: 'A chosen account is inactive' });
  if (accounts.some((a) => a.code === ACCT.pettyCash)) {
    return res.status(400).json({ error: 'Petty cash is only moved by a top-up (Finance → Petty Cash) and by expenses and wages — it cannot be journalled directly' });
  }
  if (accounts.some((a) => a.code === ACCT.receivables || a.code === ACCT.payables || a.code === ACCT.unallocatedMpesa)) {
    return res.status(400).json({ error: 'Receivables, payables and unallocated M-Pesa move only through orders, bills, notes and M-Pesa matching — not by journal' });
  }

  const count = await prisma.journalEntry.count();
  const entry = await prisma.journalEntry.create({
    data: {
      ref: `JV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
      date: d.date,
      memo: d.memo,
      source: d.source,
      createdByName: req.user!.name,
      lines: { create: lines.map((l) => ({ accountId: l.accountId, debit: round2(l.debit), credit: round2(l.credit), memo: l.memo ?? '' })) },
    },
    include: { lines: true },
  });
  res.status(201).json(entry);
});

// Reversing a journal is an Admin action (a reason isn't stored, so it is deliberately not a casual one).
accountingRouter.delete('/journals/:id', requireRole('Admin'), prepare, async (req, res) => {
  await prisma.journalEntry.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

// ── Reports ───────────────────────────────────────────────────────────────
accountingRouter.get('/ledger', ...accountingOnly, async (req, res) => {
  const r = range(req);
  if (!r) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  const out = await buildAccountLedger(Number(req.query.accountId), r.from, r.to);
  if (!out) return res.status(404).json({ error: 'Account not found' });
  res.json(out);
});
accountingRouter.get('/profit-loss', ...accountingOnly, async (req, res) => {
  const r = range(req);
  if (!r) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  res.json(await buildProfitLoss(r.from, r.to));
});
accountingRouter.get('/balance-sheet', ...accountingOnly, async (req, res) => res.json(await buildBalanceSheet(asOfOf(req))));
accountingRouter.get('/trial-balance', ...accountingOnly, async (req, res) => res.json(await buildTrialBalance(asOfOf(req))));
accountingRouter.get('/cash-flow', ...accountingOnly, async (req, res) => {
  const r = range(req);
  if (!r) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  res.json(await buildCashFlowStatement(r.from, r.to));
});
accountingRouter.get('/receivables', ...accountingOnly, async (req, res) => res.json(await buildReceivablesAging(asOfOf(req))));
accountingRouter.get('/payables', ...accountingOnly, async (req, res) => res.json(await buildPayablesAging(asOfOf(req))));
accountingRouter.get('/reconcile', ...accountingOnly, async (req, res) => {
  const r = range(req);
  if (!r) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  res.json(await reconcile(r.from, r.to, asOfOf(req)));
});

// ── Depreciation ──────────────────────────────────────────────────────────
accountingRouter.get('/depreciation', ...accountingOnly, async (req, res) => {
  const r = range(req) ?? { from: `${todayStr().slice(0, 4)}-01-01`, to: todayStr() };
  const rows = await depreciationSchedule(r.from, r.to, asOfOf(req));
  res.json({
    from: r.from,
    to: r.to,
    rows,
    totals: {
      cost: round2(rows.reduce((a, x) => a + x.cost, 0)),
      chargedToDate: round2(rows.reduce((a, x) => a + x.chargedToDate, 0)),
      bookValue: round2(rows.reduce((a, x) => a + x.bookValue, 0)),
      thisPeriod: round2(rows.reduce((a, x) => a + x.thisPeriod, 0)),
    },
    methods: DEPRECIATION_METHODS,
  });
});
accountingRouter.post('/depreciation/run', ...accountingOnly, async (_req, res) => {
  res.json({ created: await runDepreciationOnce() });
});

// ── Credit & debit notes ──────────────────────────────────────────────────
accountingRouter.get('/notes', ...accountingOnly, async (req, res) => {
  const r = range(req);
  const notes = await prisma.adjustmentNote.findMany({
    where: r ? { date: { gte: r.from, lte: r.to } } : undefined,
    include: { order: true, expense: true },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  });
  res.json(
    notes.map((n) => ({
      id: n.id, number: n.number, type: n.type, date: n.date, party: n.party, reason: n.reason,
      net: n.net, vat: n.vat, total: n.total, receivableAmt: n.receivableAmt, creditAmt: n.creditAmt, refundAmt: n.refundAmt, refundMethod: n.refundMethod,
      restocked: n.restocked, createdByName: n.createdByName,
      against: n.order ? n.order.orderNo : n.expense ? `${n.expense.invoiceNumber || `EXP-${n.expense.id}`} (${n.expense.category})` : '',
      items: n.itemsJson ? JSON.parse(n.itemsJson) : null,
    })),
  );
});

// Orders a customer note can be raised against, and expenses a supplier note can be raised against.
accountingRouter.get('/notes/sources', ...accountingOnly, async (_req, res) => {
  const [orders, expenses] = await Promise.all([
    prisma.order.findMany({ where: { OR: [{ kind: 'walkin' }, { status: { not: 'Quote' } }] }, include: { corporateClient: true }, orderBy: { id: 'desc' }, take: 300 }),
    prisma.expense.findMany({ orderBy: { id: 'desc' }, take: 300 }),
  ]);
  res.json({
    orders: orders.map((o) => ({ id: o.id, orderNo: o.orderNo, party: o.customerName || o.corporateClient?.name || 'Customer', date: o.createdDate, status: o.status })),
    expenses: expenses.map((e) => ({ id: e.id, ref: e.invoiceNumber || `EXP-${e.id}`, supplier: e.supplier, category: e.category, amount: e.amount, date: e.date })),
  });
});
accountingRouter.get('/notes/order/:id', ...accountingOnly, async (req, res) => {
  const info = await creditableLines(Number(req.params.id));
  if (!info) return res.status(404).json({ error: 'Order not found' });
  res.json(info);
});

function noteError(res: Response, e: unknown) {
  if (e instanceof NoteError) return res.status(e.status).json({ error: e.message });
  throw e;
}

const creditSchema = z.object({
  orderId: z.number().int(),
  reason: z.string().min(1),
  items: z.array(z.object({ lineId: z.number().int(), qty: z.number().positive() })).optional(),
  amount: z.number().positive().optional(),
  restock: z.boolean().optional(),
  refund: z.object({ method: z.enum(PAYOUT_METHODS), amount: z.number().positive() }).nullable().optional(),
  date: dateStr.optional(),
});
accountingRouter.post('/notes/credit', ...accountingOnly, async (req, res) => {
  const parsed = creditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  try {
    res.status(201).json(await issueCreditNote({ ...parsed.data, date: parsed.data.date ?? todayStr(), createdBy: req.user!.name }));
  } catch (e) {
    noteError(res, e);
  }
});

const debitSchema = z.object({ orderId: z.number().int(), reason: z.string().min(1), amount: z.number().positive(), incomeAccountId: z.number().int().nullable().optional(), date: dateStr.optional() });
accountingRouter.post('/notes/debit', ...accountingOnly, async (req, res) => {
  const parsed = debitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  try {
    res.status(201).json(await issueDebitNote({ ...parsed.data, date: parsed.data.date ?? todayStr(), createdBy: req.user!.name }));
  } catch (e) {
    noteError(res, e);
  }
});

const supplierSchema = z.object({ expenseId: z.number().int().nullable().optional(), supplier: z.string().optional(), reason: z.string().min(1), amount: z.number().positive(), date: dateStr.optional() });
accountingRouter.post('/notes/supplier', ...accountingOnly, async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  try {
    res.status(201).json(await issueSupplierDebitNote({ ...parsed.data, date: parsed.data.date ?? todayStr(), createdBy: req.user!.name }));
  } catch (e) {
    noteError(res, e);
  }
});

// ── M-Pesa payment matching ───────────────────────────────────────────────
accountingRouter.get('/mpesa', ...mpesaAccess, async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
  const [txs, targets] = await Promise.all([
    prisma.mpesaTransaction.findMany({
      where: { kind: { in: ['C2B', 'Import'] }, ...(status ? { status } : {}) },
      include: { order: true },
      orderBy: [{ receivedOn: 'desc' }, { id: 'desc' }],
      take: 500,
    }),
    openTargets(),
  ]);
  const rows = txs.map((t) => {
    const incoming = { amount: t.amount, phone: t.phone, accountReference: t.accountReference };
    const m = t.status === 'Unmatched' ? matchPayment(incoming, targets) : null;
    return {
      id: t.id, receipt: t.mpesaReceipt, kind: t.kind, status: t.status, amount: t.amount, phone: t.phone, payerName: t.payerName, reference: t.accountReference, receivedOn: t.receivedOn,
      appliedTo: t.order?.orderNo ?? null, appliedByName: t.appliedByName, dismissedNote: t.dismissedNote,
      suggestions: t.status === 'Unmatched' ? suggestionsFor(incoming, targets).map((s) => ({ ...s, best: m?.matched ? m.target.orderId === s.orderId : false })) : [],
      note: m && !m.matched ? m.reason : null,
    };
  });
  const unmatched = rows.filter((r) => r.status === 'Unmatched');
  // Recorded M-Pesa payments with no receipt code can't be checked against the statement.
  const unverified = await prisma.payment.findMany({ where: { method: 'M-Pesa', reference: null }, include: { order: true }, orderBy: { id: 'desc' }, take: 200 });
  res.json({
    rows,
    summary: { unmatchedCount: unmatched.length, unmatchedTotal: round2(unmatched.reduce((a, r) => a + r.amount, 0)) },
    openOrders: targets.map((t) => ({ orderId: t.orderId, ref: t.ref, party: t.party, balance: t.balance })),
    unverifiedPayments: unverified.map((p) => ({ id: p.id, orderNo: p.order.orderNo, date: p.date, amount: p.amount })),
  });
});

accountingRouter.post('/mpesa/import', ...mpesaAccess, async (req, res) => {
  const text = String((req.body as { text?: string }).text || '');
  if (text.trim().length < 10) return res.status(400).json({ error: 'Paste the M-Pesa statement (CSV) first' });
  const result = await importStatement(text, req.user!.name);
  if (result.read === 0) return res.status(400).json({ error: 'No incoming payments were found. Check the file has a "Receipt No." column and Paid In amounts.' });
  res.json(result);
});

accountingRouter.post('/mpesa/auto-match', ...mpesaAccess, async (req, res) => {
  res.json({ applied: await autoMatch(req.user!.name) });
});

accountingRouter.post('/mpesa/:id/apply', ...mpesaAccess, async (req, res) => {
  const orderId = Number((req.body as { orderId?: number }).orderId);
  if (!orderId) return res.status(400).json({ error: 'Choose the order this payment is for' });
  try {
    await applyReceiptToOrder(Number(req.params.id), orderId, req.user!.name);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof PaymentError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// Not ours / a duplicate: taken out of the books (it never was our money, or was already counted another way).
accountingRouter.post('/mpesa/:id/dismiss', ...mpesaAccess, async (req, res) => {
  const note = String((req.body as { note?: string }).note || '').trim();
  if (!note) return res.status(400).json({ error: 'Say why this payment is being dismissed' });
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: Number(req.params.id) } });
  if (!tx || tx.status !== 'Unmatched') return res.status(400).json({ error: 'Only an unmatched payment can be dismissed' });
  await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { status: 'Dismissed', dismissedNote: note.slice(0, 200), appliedByName: req.user!.name, appliedAt: new Date() } });
  res.json({ ok: true });
});

export { SYSTEM_ACCOUNT_CODES };
