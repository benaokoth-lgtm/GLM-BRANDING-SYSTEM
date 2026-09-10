import { Fragment, useEffect, useState } from 'react';
import { EMPLOYEE_TYPES, EXPENSE_CATEGORIES, PAYMENT_METHODS, PETTY_CASH_SOURCES, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import type { EmployeeType, ExpenseCategory, PaymentMethod, PettyCashSource } from '@glm/shared';
import { api } from '../api/client';
import type { DeletableRecordType, DeletionRequest, ExpenseAmendment, ExpensesData, PayrollData, PettyCashData, VatData } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';

type FinanceTab = 'vat' | 'nssf' | 'shif' | 'payroll' | 'expenses' | 'pettycash';
type Preset = 'month' | 'quarter' | 'year' | 'last12';

const TABS: [FinanceTab, string][] = [
  ['vat', 'VAT'],
  ['nssf', 'NSSF'],
  ['shif', 'SHIF'],
  ['payroll', 'Payroll'],
  ['expenses', 'Expenses'],
  ['pettycash', 'Petty Cash'],
];

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
  category: ExpenseCategory;
  note: string;
  amount: string;
}

function ExpenseCaptureForm({
  draft,
  setDraft,
  onSubmit,
  busy,
}: {
  draft: ExpenseDraft;
  setDraft: (fn: (d: ExpenseDraft) => ExpenseDraft) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
      <div className="field">
        <label>Date</label>
        <input className="input" type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
      </div>
      <div className="field">
        <label>Category</label>
        <select className="input" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as ExpenseCategory }))}>
          {EXPENSE_CATEGORIES.map((cat) => (
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
  );
}

function DeleteReasonRow({
  colSpan,
  reason,
  setReason,
  onSubmit,
  onCancel,
  busy,
}: {
  colSpan: number;
  reason: string;
  setReason: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ background: 'var(--color-surface)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
          <div className="field" style={{ margin: 0, flex: 1 }}>
            <label>Reason for deletion</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required" />
          </div>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy}>
            Submit
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

function DeletionRequestsCard({
  title,
  requests,
  onDecide,
  busy,
}: {
  title: string;
  requests: DeletionRequest[];
  onDecide: (id: number, approve: boolean) => void;
  busy: boolean;
}) {
  const pendingCount = requests.filter((r) => r.status === 'Pending').length;
  return (
    <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
        {title} {pendingCount > 0 && <span className="tag tag-accent">{pendingCount} pending</span>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Requested</th>
            <th>Record</th>
            <th>Reason</th>
            <th>Requested by</th>
            <th>Status</th>
            <th className="no-print"></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
              <td>{r.summary}</td>
              <td className="text-muted">{r.reason}</td>
              <td className="text-muted">{r.requestedByName}</td>
              <td>
                <span className={r.status === 'Approved' ? 'tag tag-accent' : r.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{r.status}</span>
              </td>
              <td className="no-print">
                {r.status === 'Pending' && (
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => onDecide(r.id, true)} disabled={busy}>
                      Approve
                    </button>
                    <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => onDecide(r.id, false)} disabled={busy}>
                      Reject
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests.length === 0 && <p className="note">No deletion requests.</p>}
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        You can't approve or reject your own deletion request — a different finance manager/general manager/admin must
        review it.
      </p>
    </div>
  );
}

export default function Finance() {
  const today = todayStr();
  const initial = presetRange('month', today);
  const { staff } = useCatalog();
  const [tab, setTab] = useState<FinanceTab>('vat');
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [vat, setVat] = useState<VatData | null>(null);
  const [payroll, setPayroll] = useState<PayrollData | null>(null);
  const [expenses, setExpenses] = useState<ExpensesData | null>(null);
  const [pettyCash, setPettyCash] = useState<PettyCashData | null>(null);
  const [amendments, setAmendments] = useState<ExpenseAmendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const staffOnly = staff.filter((s) => s.role === 'Staff');

  const [newEntry, setNewEntry] = useState({
    date: today,
    staffId: null as number | null,
    employeeType: 'Employee' as EmployeeType,
    department: '',
    daysWorked: '',
    rate: '',
    paymentMethod: 'Cash' as PaymentMethod,
  });

  const [newExpense, setNewExpense] = useState<ExpenseDraft>({
    date: today,
    category: EXPENSE_CATEGORIES[0] as ExpenseCategory,
    note: '',
    amount: '',
  });

  const [newPettyExpense, setNewPettyExpense] = useState<ExpenseDraft>({
    date: today,
    category: EXPENSE_CATEGORIES[0] as ExpenseCategory,
    note: '',
    amount: '',
  });

  const [newTopUp, setNewTopUp] = useState({
    date: today,
    source: PETTY_CASH_SOURCES[0] as PettyCashSource,
    note: '',
    amount: '',
  });

  const [amendingId, setAmendingId] = useState<number | null>(null);
  const [amendDraft, setAmendDraft] = useState({ date: '', category: EXPENSE_CATEGORIES[0] as ExpenseCategory, note: '', amount: '', reason: '' });

  const [deletionRequests, setDeletionRequests] = useState<DeletionRequest[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{ type: DeletableRecordType; id: number } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  function load() {
    setLoading(true);
    Promise.all([
      api.get<VatData>(`/finance/vat?from=${fromDate}&to=${toDate}`),
      api.get<PayrollData>(`/finance/payroll?from=${fromDate}&to=${toDate}`),
      api.get<ExpensesData>(`/finance/expenses?from=${fromDate}&to=${toDate}`),
      api.get<PettyCashData>(`/finance/petty-cash?from=${fromDate}&to=${toDate}`),
      api.get<ExpenseAmendment[]>('/finance/expenses/amendments'),
      api.get<DeletionRequest[]>('/finance/deletion-requests'),
    ])
      .then(([v, p, ex, pc, am, del]) => {
        setVat(v);
        setPayroll(p);
        setExpenses(ex);
        setPettyCash(pc);
        setAmendments(am);
        setDeletionRequests(del);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [fromDate, toDate]);

  useEffect(() => {
    if (newEntry.staffId === null && staffOnly.length > 0) {
      setNewEntry((ne) => ({ ...ne, staffId: staffOnly[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffOnly.length]);

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  async function addEntry() {
    const daysWorked = Number(newEntry.daysWorked);
    const rate = Number(newEntry.rate);
    if (!newEntry.staffId) return setError('Select a staff member');
    if (!daysWorked || daysWorked <= 0) return setError('Days worked must be greater than 0');
    if (!rate || rate <= 0) return setError('Rate must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/finance/payroll', { ...newEntry, daysWorked, rate });
      setNewEntry((ne) => ({ ...ne, department: '', daysWorked: '', rate: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add payroll entry');
    } finally {
      setBusy(false);
    }
  }

  async function submitExpense(draft: ExpenseDraft, reset: () => void) {
    const amount = Number(draft.amount);
    if (!amount || amount <= 0) return setError('Amount must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/finance/expenses', { ...draft, amount });
      reset();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add expense');
    } finally {
      setBusy(false);
    }
  }

  function startAmend(e: ExpensesData['rows'][number]) {
    setAmendingId(e.id);
    setAmendDraft({ date: e.date, category: e.category as ExpenseCategory, note: e.note, amount: String(e.amount), reason: '' });
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

  if (loading || !vat || !payroll || !expenses || !pettyCash) return <p className="note">Loading…</p>;

  const grossPreview = (Number(newEntry.daysWorked) || 0) * (Number(newEntry.rate) || 0);
  const employeeRows = payroll.rows.filter((r) => r.employeeType === 'Employee');
  const pendingAmendments = amendments.filter((a) => a.status === 'Pending');
  const payrollDeletionRequests = deletionRequests.filter((r) => r.recordType === 'PayrollEntry');
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

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      {tab === 'vat' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Total sales (incl. VAT)</div>
              <div className="card-title">{fmtKsh(vat.totalSales)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Net sales (excl. VAT)</div>
              <div className="card-title">{fmtKsh(vat.netSales)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Output VAT (16%)</div>
              <div className="card-title">{fmtKsh(vat.outputVat)}</div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              VAT statement
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
                <span>Walk-in sales</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.walkinSales)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0', borderBottom: '1px solid var(--color-divider)' }}>
                <span>Corporate sales (invoiced)</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.corporateSales)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '8px 0', fontFamily: 'var(--font-heading)' }}>
                <span>Total sales (VAT-inclusive)</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.totalSales)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
                <span>Net sales (excl. VAT)</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.netSales)}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  padding: '10px 0',
                  borderTop: '2px solid var(--color-text)',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 20,
                }}
              >
                <span>Output VAT (16%)</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.outputVat)}</span>
              </div>
            </div>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Assumes all sale prices already include the standard 16% VAT. Input VAT on purchases isn't tracked in this
              system yet, so this is Output VAT on sales only — not the net amount payable to KRA after input credits.
            </p>
          </div>
        </>
      )}

      {tab === 'nssf' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
            NSSF contributions
          </div>
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            6% employee + 6% employer of gross pay. Casual staff are excluded — not subject to statutory deductions.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>Gross pay</th>
                <th style={{ textAlign: 'right' }}>Employee (6%)</th>
                <th style={{ textAlign: 'right' }}>Employer (6%)</th>
                <th style={{ textAlign: 'right' }}>Total NSSF</th>
              </tr>
            </thead>
            <tbody>
              {employeeRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="text-muted">{r.department || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.grossPay)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf / 2)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf / 2)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontFamily: 'var(--font-heading)' }}>
                <td colSpan={5} style={{ textAlign: 'right', paddingRight: 12 }}>
                  Total NSSF
                </td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalNssf)}</td>
              </tr>
            </tfoot>
          </table>
          {employeeRows.length === 0 && <p className="note">No employee pay entries in range.</p>}
        </div>
      )}

      {tab === 'shif' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
            SHIF contributions
          </div>
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            2.75% of gross pay (minimum Ksh 300). Casual staff are excluded — not subject to statutory deductions.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>Gross pay</th>
                <th style={{ textAlign: 'right' }}>SHIF (2.75%)</th>
              </tr>
            </thead>
            <tbody>
              {employeeRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="text-muted">{r.department || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.grossPay)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.shif)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontFamily: 'var(--font-heading)' }}>
                <td colSpan={3} style={{ textAlign: 'right', paddingRight: 12 }}>
                  Total SHIF
                </td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalShif)}</td>
              </tr>
            </tfoot>
          </table>
          {employeeRows.length === 0 && <p className="note">No employee pay entries in range.</p>}
        </div>
      )}

      {tab === 'payroll' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Gross payroll</div>
              <div className="card-title">{fmtKsh(payroll.grossPayroll)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Statutory deductions</div>
              <div className="card-title">{fmtKsh(payroll.totalStatutory)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Net payroll</div>
              <div className="card-title">{fmtKsh(payroll.netPayroll)}</div>
            </div>
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Log pay
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 0.8fr 1fr 0.7fr 0.7fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={newEntry.date} onChange={(e) => setNewEntry((ne) => ({ ...ne, date: e.target.value }))} />
              </div>
              <div className="field">
                <label>Staff (from Master Data)</label>
                <select className="input" value={newEntry.staffId ?? ''} onChange={(e) => setNewEntry((ne) => ({ ...ne, staffId: Number(e.target.value) }))}>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Type</label>
                <select className="input" value={newEntry.employeeType} onChange={(e) => setNewEntry((ne) => ({ ...ne, employeeType: e.target.value as EmployeeType }))}>
                  {EMPLOYEE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Department</label>
                <input className="input" value={newEntry.department} onChange={(e) => setNewEntry((ne) => ({ ...ne, department: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Days</label>
                <input className="input" value={newEntry.daysWorked} onChange={(e) => setNewEntry((ne) => ({ ...ne, daysWorked: e.target.value }))} />
              </div>
              <div className="field">
                <label>Rate (Ksh/day)</label>
                <input className="input" value={newEntry.rate} onChange={(e) => setNewEntry((ne) => ({ ...ne, rate: e.target.value }))} />
              </div>
              <div className="field">
                <label>Method</label>
                <select className="input" value={newEntry.paymentMethod} onChange={(e) => setNewEntry((ne) => ({ ...ne, paymentMethod: e.target.value as PaymentMethod }))}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={addEntry} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Add
              </button>
            </div>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Gross pay preview: {fmtKsh(grossPreview)}. For a monthly salary, use Days = 1 and Rate = the gross salary.
              PAYE, NSSF, SHIF and Housing Levy are computed automatically for Employees — Casuals are not subject to
              statutory deductions. Staff names come from Master Data → Staff &amp; Users.
            </p>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Payroll log
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Department</th>
                    <th style={{ textAlign: 'right' }}>Gross pay</th>
                    <th style={{ textAlign: 'right' }}>PAYE</th>
                    <th style={{ textAlign: 'right' }}>NSSF</th>
                    <th style={{ textAlign: 'right' }}>SHIF</th>
                    <th style={{ textAlign: 'right' }}>Housing Levy</th>
                    <th style={{ textAlign: 'right' }}>Net pay</th>
                    <th>Captured by</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {payroll.rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="text-muted">{fmtDate(r.date)}</td>
                        <td>{r.name}</td>
                        <td>
                          <span className={r.employeeType === 'Employee' ? 'tag tag-accent' : 'tag tag-neutral'}>{r.employeeType}</span>
                        </td>
                        <td className="text-muted">{r.department || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.grossPay)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.paye)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.shif)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.housingLevy)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(r.netPay)}</td>
                        <td className="text-muted">{r.capturedByName || '—'}</td>
                        <td className="no-print">
                          {pendingDeletionFor('PayrollEntry', r.id) ? (
                            <span className="tag tag-outline" style={{ fontSize: 10 }}>
                              Deletion pending
                            </span>
                          ) : (
                            <button type="button" className="btn btn-ghost btn-icon" aria-label="Delete" onClick={() => startDelete('PayrollEntry', r.id)} disabled={busy}>
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                      {deleteTarget?.type === 'PayrollEntry' && deleteTarget.id === r.id && (
                        <DeleteReasonRow colSpan={12} reason={deleteReason} setReason={setDeleteReason} onSubmit={submitDeleteRequest} onCancel={() => setDeleteTarget(null)} busy={busy} />
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontFamily: 'var(--font-heading)' }}>
                    <td colSpan={4} style={{ textAlign: 'right', paddingRight: 12 }}>
                      Totals
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.grossPayroll)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalPaye)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalNssf)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalShif)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalHousingLevy)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.netPayroll)}</td>
                    <td></td>
                    <td className="no-print"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {payroll.rows.length === 0 && <p className="note">No payroll entries in range.</p>}
          </div>

          <DeletionRequestsCard title="Payroll deletion requests" requests={payrollDeletionRequests} onDecide={decideDeletion} busy={busy} />
        </>
      )}

      {tab === 'expenses' && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Operating expenses
            </div>

            <ExpenseCaptureForm draft={newExpense} setDraft={setNewExpense} busy={busy} onSubmit={() => submitExpense(newExpense, () => setNewExpense((d) => ({ ...d, note: '', amount: '' })))} />

            <table className="table" style={{ marginTop: 'var(--space-4)' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Note</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
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
                      <td className="text-muted">{e.note}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(e.amount)}</td>
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
                      <DeleteReasonRow colSpan={6} reason={deleteReason} setReason={setDeleteReason} onSubmit={submitDeleteRequest} onCancel={() => setDeleteTarget(null)} busy={busy} />
                    )}
                    {amendingId === e.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--color-surface)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1.6fr auto auto', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Date</label>
                              <input className="input" type="date" value={amendDraft.date} onChange={(ev) => setAmendDraft((d) => ({ ...d, date: ev.target.value }))} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Category</label>
                              <select className="input" value={amendDraft.category} onChange={(ev) => setAmendDraft((d) => ({ ...d, category: ev.target.value as ExpenseCategory }))}>
                                {EXPENSE_CATEGORIES.map((cat) => (
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
                  <td colSpan={3} style={{ textAlign: 'right', paddingRight: 12 }}>
                    Total
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(expenses.totalExpenses)}</td>
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

      {tab === 'pettycash' && (
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
              draft={newPettyExpense}
              setDraft={setNewPettyExpense}
              busy={busy}
              onSubmit={() => submitExpense(newPettyExpense, () => setNewPettyExpense((d) => ({ ...d, note: '', amount: '' })))}
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
