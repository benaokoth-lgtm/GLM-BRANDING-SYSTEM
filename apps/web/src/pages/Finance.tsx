import { Fragment, useEffect, useState } from 'react';
import { EXPENSE_CATEGORIES, EXPENSE_METHODS, PETTY_CASH_SOURCES, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import type { ExpenseCategory, PettyCashSource } from '@glm/shared';
import { api } from '../api/client';
import type { BusinessHeadRow, DeletableRecordType, DeletionRequest, ExpenseAmendment, ExpensesData, PettyCashData } from '../api/models';
import DeleteReasonRow from '../components/DeleteReasonRow';
import DeletionRequestsCard from '../components/DeletionRequestsCard';
import CorporateOrderForm from '../components/CorporateOrderForm';
import AssetRegister from '../components/AssetRegister';
import Orders from './Orders';
import Payments from './Payments';

// Quotation, Invoice, All Orders and Payments all moved in here from
// their own top-level nav entries — one "Finance" tab for everything a
// Finance Manager/General Manager/Admin does, instead of six scattered
// links (see AppLayout.tsx's buildTabs). Supervisor, who has order/payment
// oversight but not Finance access, still reaches All Orders/Payments as
// their own top-level entries — this consolidation only applies once
// canAccessFinance is already true.
type FinanceTab = 'quotation' | 'invoice' | 'allOrders' | 'payments' | 'expenses' | 'pettycash' | 'assets';
type Preset = 'month' | 'quarter' | 'year' | 'last12';

const TABS: [FinanceTab, string][] = [
  ['quotation', 'Quotation'],
  ['invoice', 'Invoice'],
  ['allOrders', 'All Orders'],
  ['payments', 'Payments'],
  ['expenses', 'Expenses'],
  ['pettycash', 'Petty Cash'],
  ['assets', 'Asset Register'],
];

// Tabs that manage their own data/date-range internally — the shared
// preset/from-to filter bar below (and the Expenses/Petty Cash data load)
// isn't relevant to them.
const SELF_CONTAINED_TABS: FinanceTab[] = ['quotation', 'invoice', 'allOrders', 'payments', 'assets'];

function presetRange(preset: Preset, today: string): { from: string; to: string } {
  const y = today.slice(0, 4);
  const m = today.slice(5, 7);
  if (preset === 'month') return { from: `${y}-${m}-01`, to: today };
  if (preset === 'quarter') {
    const qm = Math.floor((Number(m) - 1) / 3) * 3 + 1;
    return { from: `${y}-${String(qm).padStart(2, '0')}-01`, to: today };
  }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  const d = new Date(today + 'T00:00:00');
  d.setMonth(d.getMonth() - 11);
  d.setDate(1);
  return { from: d.toISOString().slice(0, 10), to: today };
}

interface ExpenseDraft {
  date: string;
  category: string;
  note: string;
  amount: string;
  invoiceNumber: string;
  // How it was paid; "on credit" records a bill that sits in Accounts Payable until paid.
  method: string;
  onCredit: boolean;
  supplier: string;
  dueDate: string;
  // The business head this cost belongs to ('' = shared, not tagged to one).
  businessHeadId: string;
}

function ExpenseCaptureForm({
  draft,
  setDraft,
  onSubmit,
  busy,
  categories,
  heads,
  full,
}: {
  draft: ExpenseDraft;
  setDraft: (fn: (d: ExpenseDraft) => ExpenseDraft) => void;
  onSubmit: () => void;
  busy: boolean;
  categories: readonly string[];
  heads: { id: number; name: string }[];
  /** The Expenses tab offers payment method / on-credit; the Petty Cash tab is always petty cash. */
  full: boolean;
}) {
  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 1fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
      <div className="field">
        <label>Date</label>
        <input className="input" type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
      </div>
      <div className="field">
        <label>Category</label>
        <select className="input" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Note</label>
        <input className="input" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder="Optional" />
      </div>
      <div className="field">
        <label>Invoice/receipt #</label>
        <input className="input" value={draft.invoiceNumber} onChange={(e) => setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))} placeholder="Optional" />
      </div>
      <div className="field">
        <label>Amount (Ksh)</label>
        <input className="input" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} />
      </div>
      <button type="button" className="btn btn-primary blueprint" onClick={onSubmit} disabled={busy}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        Add
      </button>
    </div>
    <div className="field" style={{ maxWidth: 320, marginTop: 'var(--space-3)' }}>
      <label>Business head (optional)</label>
      <select className="input" value={draft.businessHeadId} onChange={(e) => setDraft((d) => ({ ...d, businessHeadId: e.target.value }))}>
        <option value="">Shared — not tagged to one</option>
        {heads.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </div>
    {full && (
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr', gap: 'var(--space-3)', alignItems: 'end', marginTop: 'var(--space-3)' }}>
        <div className="field">
          <label>Paid by</label>
          <select className="input" value={draft.onCredit ? 'credit' : draft.method} onChange={(e) => (e.target.value === 'credit' ? setDraft((d) => ({ ...d, onCredit: true })) : setDraft((d) => ({ ...d, onCredit: false, method: e.target.value })))}>
            {EXPENSE_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="credit">On credit (pay the supplier later)</option>
          </select>
        </div>
        {draft.onCredit ? (
          <>
            <div className="field">
              <label>Supplier</label>
              <input className="input" value={draft.supplier} onChange={(e) => setDraft((d) => ({ ...d, supplier: e.target.value }))} placeholder="Required for credit" />
            </div>
            <div className="field">
              <label>Payment due</label>
              <input className="input" type="date" value={draft.dueDate} onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))} />
            </div>
            <span className="note">Goes to Accounts Payable until you pay it.</span>
          </>
        ) : (
          <>
            <div className="field">
              <label>Supplier (optional)</label>
              <input className="input" value={draft.supplier} onChange={(e) => setDraft((d) => ({ ...d, supplier: e.target.value }))} />
            </div>
            <span />
            <span className="note">{draft.method === 'Petty Cash' ? 'Comes out of the petty cash float.' : ''}</span>
          </>
        )}
      </div>
    )}
    </>
  );
}

export default function Finance() {
  const today = todayStr();
  const initial = presetRange('month', today);
  const [tab, setTab] = useState<FinanceTab>('expenses');
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [expenses, setExpenses] = useState<ExpensesData | null>(null);
  const [pettyCash, setPettyCash] = useState<PettyCashData | null>(null);
  const [amendments, setAmendments] = useState<ExpenseAmendment[]>([]);
  const [heads, setHeads] = useState<BusinessHeadRow[]>([]);
  const activeHeads = heads.filter((h) => h.active);
  useEffect(() => {
    api.get<BusinessHeadRow[]>('/master-data/business-heads').then(setHeads).catch(() => setHeads([]));
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newExpense, setNewExpense] = useState<ExpenseDraft>({
    date: today,
    category: EXPENSE_CATEGORIES[0] as string,
    note: '',
    amount: '',
    invoiceNumber: '',
    method: 'Petty Cash',
    onCredit: false,
    supplier: '',
    dueDate: '',
    businessHeadId: '',
  });

  const [newPettyExpense, setNewPettyExpense] = useState<ExpenseDraft>({
    date: today,
    category: EXPENSE_CATEGORIES[0] as string,
    note: '',
    amount: '',
    invoiceNumber: '',
    method: 'Petty Cash',
    onCredit: false,
    supplier: '',
    dueDate: '',
    businessHeadId: '',
  });

  const [newTopUp, setNewTopUp] = useState({
    date: today,
    source: PETTY_CASH_SOURCES[0] as PettyCashSource,
    note: '',
    amount: '',
  });

  // Paying down an expense bought on credit.
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payDraft, setPayDraft] = useState({ date: today, amount: '', method: 'Bank Transfer' });

  const [amendingId, setAmendingId] = useState<number | null>(null);
  const [amendDraft, setAmendDraft] = useState({ date: '', category: EXPENSE_CATEGORIES[0] as string, note: '', amount: '', reason: '' });

  const [deletionRequests, setDeletionRequests] = useState<DeletionRequest[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{ type: DeletableRecordType; id: number } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const [justCreated, setJustCreated] = useState<{ kind: 'quote' | 'invoice'; orderNo: string } | null>(null);
  function handleOrderCreated(kind: 'quote' | 'invoice', orderNo: string) {
    setJustCreated({ kind, orderNo });
  }

  function load() {
    setLoading(true);
    Promise.all([
      api.get<ExpensesData>(`/finance/expenses?from=${fromDate}&to=${toDate}`),
      api.get<PettyCashData>(`/finance/petty-cash?from=${fromDate}&to=${toDate}`),
      api.get<ExpenseAmendment[]>('/finance/expenses/amendments'),
      api.get<DeletionRequest[]>('/finance/deletion-requests'),
    ])
      .then(([ex, pc, am, del]) => {
        setExpenses(ex);
        setPettyCash(pc);
        setAmendments(am);
        setDeletionRequests(del);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [fromDate, toDate]);

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  // Tagging an expense to a line of business (or clearing it) changes no amount, so it needs no amendment request.
  async function retagExpense(expenseId: number, value: string) {
    setError(null);
    try {
      await api.patch(`/finance/expenses/${expenseId}/business-head`, { businessHeadId: value ? Number(value) : null });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to tag the expense');
    }
  }

  async function submitExpense(draft: ExpenseDraft, reset: () => void) {
    const amount = Number(draft.amount);
    if (!amount || amount <= 0) return setError('Amount must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/finance/expenses', {
        date: draft.date,
        category: draft.category,
        note: draft.note,
        amount,
        invoiceNumber: draft.invoiceNumber || undefined,
        method: draft.onCredit ? 'Petty Cash' : draft.method,
        paid: !draft.onCredit,
        supplier: draft.supplier || undefined,
        dueDate: draft.onCredit && draft.dueDate ? draft.dueDate : undefined,
        businessHeadId: draft.businessHeadId ? Number(draft.businessHeadId) : null,
      });
      reset();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add expense');
    } finally {
      setBusy(false);
    }
  }

  async function submitSupplierPayment(expenseId: number) {
    const amount = Number(payDraft.amount);
    if (!amount || amount <= 0) return setError('Amount must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post(`/finance/expenses/${expenseId}/payments`, { date: payDraft.date, amount, method: payDraft.method });
      setPayingId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  }

  function startAmend(e: ExpensesData['rows'][number]) {
    setAmendingId(e.id);
    setAmendDraft({ date: e.date, category: e.category, note: e.note, amount: String(e.amount), reason: '' });
    setError(null);
  }

  async function submitAmendment(expenseId: number) {
    const amount = Number(amendDraft.amount);
    if (!amount || amount <= 0) return setError('Amount must be greater than 0');
    if (!amendDraft.reason.trim()) return setError('A reason for the amendment is required');
    setError(null);
    setBusy(true);
    try {
      await api.post(`/finance/expenses/${expenseId}/amend`, { ...amendDraft, amount });
      setAmendingId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit amendment');
    } finally {
      setBusy(false);
    }
  }

  async function decideAmendment(id: number, approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/finance/expenses/amendments/${id}/${approve ? 'approve' : 'reject'}`, {});
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decide amendment');
    } finally {
      setBusy(false);
    }
  }

  async function addTopUp() {
    const amount = Number(newTopUp.amount);
    if (!amount || amount <= 0) return setError('Amount must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/finance/petty-cash/topups', { ...newTopUp, amount });
      setNewTopUp((nt) => ({ ...nt, note: '', amount: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add petty cash top-up');
    } finally {
      setBusy(false);
    }
  }

  function startDelete(type: DeletableRecordType, id: number) {
    setDeleteTarget({ type, id });
    setDeleteReason('');
    setError(null);
  }

  async function submitDeleteRequest() {
    if (!deleteTarget) return;
    if (!deleteReason.trim()) return setError('A reason for the deletion is required');
    setError(null);
    setBusy(true);
    try {
      await api.post('/finance/deletion-requests', { recordType: deleteTarget.type, recordId: deleteTarget.id, reason: deleteReason });
      setDeleteTarget(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit deletion request');
    } finally {
      setBusy(false);
    }
  }

  async function decideDeletion(id: number, approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/finance/deletion-requests/${id}/${approve ? 'approve' : 'reject'}`, {});
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decide deletion request');
    } finally {
      setBusy(false);
    }
  }

  function pendingDeletionFor(type: DeletableRecordType, id: number) {
    return deletionRequests.find((r) => r.recordType === type && r.recordId === id && r.status === 'Pending');
  }

  const isSelfContained = SELF_CONTAINED_TABS.includes(tab);
  if (!isSelfContained && (loading || !expenses || !pettyCash)) return <p className="note">Loading…</p>;

  const pendingAmendments = amendments.filter((a) => a.status === 'Pending');
  const expenseDeletionRequests = deletionRequests.filter((r) => r.recordType === 'Expense');
  const pettyCashDeletionRequests = deletionRequests.filter((r) => r.recordType === 'PettyCashTopUp');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={'btn blueprint ' + (tab === id ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab(id)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {label}
          </button>
        ))}
      </div>

      {justCreated && (
        <div className="card blueprint elev-sm no-print" style={{ padding: 'var(--space-3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <span>
            <span className="tag tag-accent">{justCreated.kind === 'quote' ? 'Quotation' : 'Invoice'} {justCreated.orderNo} created</span>
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setTab('allOrders');
                setJustCreated(null);
              }}
            >
              View in All Orders
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setJustCreated(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!isSelfContained && (
        <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={() => applyPreset('month')}>
                This month
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => applyPreset('quarter')}>
                This quarter
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => applyPreset('year')}>
                Year to date
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => applyPreset('last12')}>
                Last 12 months
              </button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>From</label>
                <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>To</label>
                <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={() => window.print()}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Print / PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'quotation' && <CorporateOrderForm kind="quote" onCreated={(orderNo) => handleOrderCreated('quote', orderNo)} />}
      {tab === 'invoice' && <CorporateOrderForm kind="invoice" onCreated={(orderNo) => handleOrderCreated('invoice', orderNo)} />}
      {tab === 'allOrders' && <Orders scope="all" />}
      {tab === 'payments' && <Payments />}
      {tab === 'assets' && <AssetRegister />}

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      {tab === 'expenses' && expenses && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Operating expenses
            </div>

            <ExpenseCaptureForm full categories={expenses.expenseCategories} heads={activeHeads} draft={newExpense} setDraft={setNewExpense} busy={busy} onSubmit={() => submitExpense(newExpense, () => setNewExpense((d) => ({ ...d, note: '', amount: '', invoiceNumber: '', supplier: '', dueDate: '' })))} />

            <table className="table" style={{ marginTop: 'var(--space-4)' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Business head</th>
                  <th>Note</th>
                  <th>Invoice #</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Paid</th>
                  <th>Captured by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {expenses.rows.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="text-muted">{fmtDate(e.date)}</td>
                      <td>{e.category}</td>
                      <td>
                        <select className="input" style={{ width: 150 }} value={e.businessHeadId ?? ''} onChange={(ev) => retagExpense(e.id, ev.target.value)} disabled={busy}>
                          <option value="">—</option>
                          {heads.filter((h) => h.active || h.id === e.businessHeadId).map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="text-muted">{e.note}</td>
                      <td className="text-muted">{e.invoiceNumber || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(e.amount)}</td>
                      <td>
                        {e.paid ? (
                          <span className="text-muted">{e.method}</span>
                        ) : e.outstanding > 0 ? (
                          <span>
                            <span className="tag tag-outline" style={{ fontSize: 10 }}>On credit</span>{' '}
                            {e.supplier && <span className="text-muted">{e.supplier} · </span>}
                            <strong>{fmtKsh(e.outstanding)}</strong> owed{e.dueDate ? <span className="text-muted"> · due {fmtDate(e.dueDate)}</span> : null}{' '}
                            <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setPayingId(e.id); setPayDraft({ date: today, amount: String(e.outstanding), method: 'Bank Transfer' }); setError(null); }} disabled={busy}>
                              Pay
                            </button>
                          </span>
                        ) : (
                          <span className="text-muted">Settled{e.supplier ? ` — ${e.supplier}` : ''}</span>
                        )}
                      </td>
                      <td className="text-muted">{e.capturedByName || '—'}</td>
                      <td style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => startAmend(e)} disabled={busy}>
                          Amend
                        </button>
                        {pendingDeletionFor('Expense', e.id) ? (
                          <span className="tag tag-outline" style={{ fontSize: 10 }}>
                            Deletion pending
                          </span>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-icon" aria-label="Delete" onClick={() => startDelete('Expense', e.id)} disabled={busy}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                    {deleteTarget?.type === 'Expense' && deleteTarget.id === e.id && (
                      <DeleteReasonRow colSpan={9} reason={deleteReason} setReason={setDeleteReason} onSubmit={submitDeleteRequest} onCancel={() => setDeleteTarget(null)} busy={busy} />
                    )}
                    {payingId === e.id && (
                      <tr>
                        <td colSpan={9} style={{ background: 'var(--color-surface)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr auto auto', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Payment date</label>
                              <input className="input" type="date" value={payDraft.date} onChange={(ev) => setPayDraft((d) => ({ ...d, date: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Amount (Ksh)</label>
                              <input className="input" value={payDraft.amount} onChange={(ev) => setPayDraft((d) => ({ ...d, amount: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Paid by</label>
                              <select className="input" value={payDraft.method} onChange={(ev) => setPayDraft((d) => ({ ...d, method: ev.target.value }))}>
                                {EXPENSE_METHODS.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <button type="button" className="btn btn-primary" onClick={() => submitSupplierPayment(e.id)} disabled={busy}>
                              Record payment
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={() => setPayingId(null)} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {amendingId === e.id && (
                      <tr>
                        <td colSpan={9} style={{ background: 'var(--color-surface)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1.6fr auto auto', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Date</label>
                              <input className="input" type="date" value={amendDraft.date} onChange={(ev) => setAmendDraft((d) => ({ ...d, date: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Category</label>
                              <select className="input" value={amendDraft.category} onChange={(ev) => setAmendDraft((d) => ({ ...d, category: ev.target.value }))}>
                                {(expenses?.expenseCategories ?? EXPENSE_CATEGORIES).map((cat) => (
                                  <option key={cat} value={cat}>
                                    {cat}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Note</label>
                              <input className="input" value={amendDraft.note} onChange={(ev) => setAmendDraft((d) => ({ ...d, note: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Amount</label>
                              <input className="input" value={amendDraft.amount} onChange={(ev) => setAmendDraft((d) => ({ ...d, amount: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Reason for amendment</label>
                              <input className="input" value={amendDraft.reason} onChange={(ev) => setAmendDraft((d) => ({ ...d, reason: ev.target.value }))} placeholder="Required" />
                            </div>
                            <button type="button" className="btn btn-primary" onClick={() => submitAmendment(e.id)} disabled={busy}>
                              Submit
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={() => setAmendingId(null)} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontFamily: 'var(--font-heading)' }}>
                  <td colSpan={4} style={{ textAlign: 'right', paddingRight: 12 }}>
                    Total
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(expenses.totalExpenses)}</td>
                  <td></td>
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            {expenses.rows.length === 0 && <p className="note">No expenses in range.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Feeds directly into the P&amp;L account's operating-expense lines and the Petty Cash ledger's "out" side.
              Wrong entries: use Amend with a reason, or ✕ to request deletion — either only takes effect once another
              finance manager/general manager/admin approves it below.
            </p>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Amendment requests {pendingAmendments.length > 0 && <span className="tag tag-accent">{pendingAmendments.length} pending</span>}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Requested</th>
                  <th>Current</th>
                  <th>Proposed</th>
                  <th>Reason</th>
                  <th>Requested by</th>
                  <th>Status</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {amendments.map((a) => (
                  <tr key={a.id}>
                    <td className="text-muted">{fmtDate(a.requestedAt.slice(0, 10))}</td>
                    <td>
                      {a.currentCategory} — {fmtKsh(a.currentAmount)} ({fmtDate(a.currentDate)})
                    </td>
                    <td>
                      {a.proposedCategory} — {fmtKsh(a.proposedAmount)} ({fmtDate(a.proposedDate)})
                    </td>
                    <td className="text-muted">{a.reason}</td>
                    <td className="text-muted">{a.requestedByName}</td>
                    <td>
                      <span className={a.status === 'Approved' ? 'tag tag-accent' : a.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{a.status}</span>
                    </td>
                    <td className="no-print">
                      {a.status === 'Pending' && (
                        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => decideAmendment(a.id, true)} disabled={busy}>
                            Approve
                          </button>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => decideAmendment(a.id, false)} disabled={busy}>
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {amendments.length === 0 && <p className="note">No amendment requests.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              You can't approve or reject your own amendment request — a different finance manager/general
              manager/admin must review it.
            </p>
          </div>

          <DeletionRequestsCard title="Expense deletion requests" requests={expenseDeletionRequests} onDecide={decideDeletion} busy={busy} />
        </>
      )}

      {tab === 'pettycash' && pettyCash && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Current balance</div>
              <div className="card-title">{fmtKsh(pettyCash.balance)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Top-ups this period</div>
              <div className="card-title">{fmtKsh(pettyCash.periodTopUpsTotal)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Spent this period</div>
              <div className="card-title">{fmtKsh(pettyCash.periodExpensesTotal)}</div>
            </div>
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Feed petty cash
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Only Finance Manager, General Manager and Admin can reach this screen, so every top-up recorded here is
              inherently manager-authorized. Cash sales received this period: {fmtKsh(pettyCash.cashSalesInPeriod)} —
              consider how much of that to allocate below.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1.4fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={newTopUp.date} onChange={(e) => setNewTopUp((nt) => ({ ...nt, date: e.target.value }))} />
              </div>
              <div className="field">
                <label>Source</label>
                <select className="input" value={newTopUp.source} onChange={(e) => setNewTopUp((nt) => ({ ...nt, source: e.target.value as PettyCashSource }))}>
                  {PETTY_CASH_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Note</label>
                <input className="input" value={newTopUp.note} onChange={(e) => setNewTopUp((nt) => ({ ...nt, note: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Amount (Ksh)</label>
                <input className="input" value={newTopUp.amount} onChange={(e) => setNewTopUp((nt) => ({ ...nt, amount: e.target.value }))} />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={addTopUp} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Add
              </button>
            </div>
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Log a petty cash expense
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Same ledger as Finance → Expenses — logged here for convenience while you're already reviewing the float.
            </p>
            <ExpenseCaptureForm
              full={false}
              categories={expenses?.expenseCategories ?? EXPENSE_CATEGORIES}
              heads={activeHeads}
              draft={newPettyExpense}
              setDraft={setNewPettyExpense}
              busy={busy}
              onSubmit={() => submitExpense(newPettyExpense, () => setNewPettyExpense((d) => ({ ...d, note: '', amount: '', invoiceNumber: '' })))}
            />
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Petty cash ledger
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {pettyCash.ledger.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td className="text-muted">{fmtDate(row.date)}</td>
                      <td>{row.description}</td>
                      <td style={{ textAlign: 'right' }}>{row.amountIn > 0 ? fmtKsh(row.amountIn) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{row.amountOut > 0 ? fmtKsh(row.amountOut) : '—'}</td>
                      <td className="no-print">
                        {row.type === 'topup' && row.topUpId !== null && (
                          pendingDeletionFor('PettyCashTopUp', row.topUpId) ? (
                            <span className="tag tag-outline" style={{ fontSize: 10 }}>Deletion pending</span>
                          ) : (
                            <button type="button" className="btn btn-ghost btn-icon" aria-label="Delete" onClick={() => startDelete('PettyCashTopUp', row.topUpId!)} disabled={busy}>
                              ✕
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                    {deleteTarget?.type === 'PettyCashTopUp' && row.topUpId !== null && deleteTarget.id === row.topUpId && (
                      <DeleteReasonRow colSpan={5} reason={deleteReason} setReason={setDeleteReason} onSubmit={submitDeleteRequest} onCancel={() => setDeleteTarget(null)} busy={busy} />
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {pettyCash.ledger.length === 0 && <p className="note">No petty cash activity in range.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Current balance assumes every recorded operating expense is paid from petty cash. If some (e.g. salaries
              paid by bank transfer) aren't, exclude them from the Expenses tab or track them separately. Wrong
              top-ups: ✕ to request deletion — takes effect once another finance manager/general manager/admin
              approves it below.
            </p>
          </div>

          <DeletionRequestsCard title="Petty cash deletion requests" requests={pettyCashDeletionRequests} onDecide={decideDeletion} busy={busy} />
        </>
      )}
    </div>
  );
}
