import { Fragment, useEffect, useState } from 'react';
import { EMPLOYEE_TYPES, PAYROLL_PAYMENT_SOURCES, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import type { EmployeeType, PayrollPaymentSource } from '@glm/shared';
import { useSubTab } from '../state/SubNavContext';
import { api } from '../api/client';
import type { CompanySettings, DeletableRecordType, DeletionRequest, EmployeeRow, P9Data, PayrollData, PayrollRow, VatData, VatStatementPart } from '../api/models';
import { buildP9Html, buildPayrollRegisterHtml, buildPayslipsHtml, printHtml } from '../utils/printPayroll';
import { useCatalog } from '../hooks/useCatalog';
import DeleteReasonRow from '../components/DeleteReasonRow';
import DeletionRequestsCard from '../components/DeletionRequestsCard';
import OrderDetailDialog from '../components/OrderDetailDialog';

type ComplianceTab = 'vat' | 'nssf' | 'shif' | 'payroll' | 'employees' | 'p9';
type Preset = 'month' | 'quarter' | 'year' | 'last12';

const TABS: [ComplianceTab, string][] = [
  ['vat', 'VAT'],
  ['nssf', 'NSSF'],
  ['shif', 'SHIF'],
  ['payroll', 'Payroll'],
  ['employees', 'Employees'],
  ['p9', 'P9'],
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

// One block of the VAT statement: an account per row (its amount, its VAT and the total); click an account to see the documents behind it.
function AccountStatement({ rows, totals, heads, empty }: { rows: VatStatementPart['rows']; totals: { net: number; vat: number; gross: number }; heads: [string, string, string]; empty: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Account</th>
          <th style={{ textAlign: 'right' }}>{heads[0]}</th>
          <th style={{ textAlign: 'right' }}>{heads[1]}</th>
          <th style={{ textAlign: 'right' }}>{heads[2]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={4} className="text-muted">
              {empty}
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <Fragment key={r.accountId}>
            <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.accountId ? null : r.accountId)} aria-expanded={open === r.accountId}>
              <td>
                <span className="text-muted">{open === r.accountId ? '▾' : '▸'}</span> {r.code} · {r.name} <span className="text-muted">({r.lines.length})</span>
              </td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(r.net)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(r.vat)}</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(r.gross)}</td>
            </tr>
            {open === r.accountId &&
              r.lines.map((l, i) => (
                <tr key={i} style={{ background: 'var(--color-surface)' }}>
                  <td className="text-muted" style={{ paddingLeft: 28, fontSize: 12 }}>
                    {fmtDate(l.date)} · {l.memo && l.memo.startsWith(l.ref) ? l.memo : [l.ref, l.memo].filter(Boolean).join(' — ')}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(l.net)}</td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(l.vat)}</td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(l.net + l.vat)}</td>
                </tr>
              ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td style={{ textAlign: 'right' }}>{fmtKsh(totals.net)}</td>
          <td style={{ textAlign: 'right' }}>{fmtKsh(totals.vat)}</td>
          <td style={{ textAlign: 'right' }}>{fmtKsh(totals.gross)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export default function Compliance() {
  const today = todayStr();
  const initial = presetRange('month', today);
  const { staff } = useCatalog();
  const [tab, setTab] = useSubTab<ComplianceTab>('vat');
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [vat, setVat] = useState<VatData | null>(null);
  const [payroll, setPayroll] = useState<PayrollData | null>(null);
  const [deletionRequests, setDeletionRequests] = useState<DeletionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vatOrderId, setVatOrderId] = useState<number | null>(null);

  const staffOnly = staff.filter((s) => s.role === 'Staff');

  // Employee details (National ID, KRA PIN, SHIF number) and the P9 for a year.
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [empDrafts, setEmpDrafts] = useState<Record<number, { nationalId: string; kraPin: string; shifNumber: string; basicSalary: string }>>({});
  const [p9Year, setP9Year] = useState(todayStr().slice(0, 4));
  const [p9, setP9] = useState<P9Data | null>(null);

  function loadEmployees() {
    api.get<EmployeeRow[]>('/finance/employees').then(setEmployees).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the employees'));
  }
  function loadP9() {
    if (!/^\d{4}$/.test(p9Year)) return;
    api.get<P9Data>(`/finance/p9?year=${p9Year}`).then(setP9).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the P9 figures'));
  }
  useEffect(() => {
    if (tab === 'employees') loadEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    if (tab === 'p9') loadP9();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, p9Year]);

  async function saveEmployee(id: number) {
    const d = empDrafts[id];
    if (!d) return;
    setError(null);
    setBusy(true);
    try {
      const salary = d.basicSalary.replace(/[,\s]/g, '');
      if (salary && !(Number(salary) >= 0)) throw new Error('The gross salary must be a number');
      await api.put(`/finance/employees/${id}`, { nationalId: d.nationalId, kraPin: d.kraPin, shifNumber: d.shifNumber, basicSalary: salary ? Number(salary) : null });
      setEmpDrafts((x) => {
        const { [id]: _drop, ...rest } = x;
        return rest;
      });
      loadEmployees();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the details');
    } finally {
      setBusy(false);
    }
  }

  // Printing: the popup is opened first (synchronously, so it is not blocked), then filled once the company details have loaded.
  async function printWith(build: (company: CompanySettings) => string) {
    const w = window.open('', '_blank');
    if (!w) return setError('Allow pop-ups for this site to print');
    setError(null);
    try {
      const company = await api.get<CompanySettings>('/master-data/settings');
      printHtml(w, build(company));
    } catch (err) {
      w.close();
      setError(err instanceof Error ? err.message : 'Could not print');
    }
  }
  const printRegister = () => payroll && printWith((c) => buildPayrollRegisterHtml(payroll, c));
  const printPayslips = (rows: PayrollRow[]) => printWith((c) => buildPayslipsHtml(rows, c));
  const printP9 = (staffId?: number) => p9 && printWith(() => buildP9Html(p9, staffId));


  const [newEntry, setNewEntry] = useState({
    date: today,
    staffId: null as number | null,
    employeeType: 'Employee' as EmployeeType,
    department: '',
    grossPay: '',
    daysWorked: '',
    rate: '',
    paymentSource: 'Petty Cash' as PayrollPaymentSource, // wages are always paid from petty cash
  });

  const [deleteTarget, setDeleteTarget] = useState<{ type: DeletableRecordType; id: number } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  function load() {
    setLoading(true);
    Promise.all([
      api.get<VatData>(`/finance/vat?from=${fromDate}&to=${toDate}`),
      api.get<PayrollData>(`/finance/payroll?from=${fromDate}&to=${toDate}`),
      api.get<DeletionRequest[]>('/finance/deletion-requests'),
    ])
      .then(([v, p, del]) => {
        setVat(v);
        setPayroll(p);
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

  // Whether spending on an expense head carries VAT (true / false), or null to go back to the standing answer for its name.
  async function setHeadVat(id: number, applicable: boolean | null) {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/finance/expense-heads/${id}/vat`, { applicable });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the VAT treatment');
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  async function addEntry() {
    if (!newEntry.staffId) return setError('Select a staff member');
    setError(null);

    let payload: Record<string, unknown>;
    if (newEntry.employeeType === 'Employee') {
      const grossPay = Number(newEntry.grossPay);
      if (!grossPay || grossPay <= 0) return setError('Monthly salary must be greater than 0');
      payload = { date: newEntry.date, staffId: newEntry.staffId, employeeType: 'Employee', department: newEntry.department, grossPay, paymentSource: newEntry.paymentSource };
    } else {
      const daysWorked = Number(newEntry.daysWorked);
      const rate = Number(newEntry.rate);
      if (!daysWorked || daysWorked <= 0) return setError('Days worked must be greater than 0');
      if (!rate || rate <= 0) return setError('Rate must be greater than 0');
      payload = { date: newEntry.date, staffId: newEntry.staffId, employeeType: 'Casual', department: newEntry.department, daysWorked, rate, paymentSource: newEntry.paymentSource };
    }

    setBusy(true);
    try {
      await api.post('/finance/payroll', payload);
      setNewEntry((ne) => ({ ...ne, department: '', grossPay: '', daysWorked: '', rate: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add payroll entry');
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

  if (loading || !vat || !payroll) return <p className="note">Loading…</p>;

  const grossPreview = newEntry.employeeType === 'Employee' ? Number(newEntry.grossPay) || 0 : (Number(newEntry.daysWorked) || 0) * (Number(newEntry.rate) || 0);
  const employeeRows = payroll.rows.filter((r) => r.employeeType === 'Employee');
  const payrollDeletionRequests = deletionRequests.filter((r) => r.recordType === 'PayrollEntry');

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
        <p className="note" style={{ color: 'var(--color-error)' }}>
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
              <div className="card-kicker">Output VAT — on sales</div>
              <div className="card-title">{fmtKsh(vat.outputVat)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Input VAT — on purchases &amp; expenses</div>
              <div className="card-title">{fmtKsh(vat.inputVat)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">{vat.netVatPayable < 0 ? 'VAT refundable / carried forward' : 'Net VAT payable to KRA'}</div>
              <div className="card-title">{fmtKsh(Math.abs(vat.netVatPayable))}</div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-1)' }}>
              VAT statement
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              {fmtDate(vat.fromDate)} to {fmtDate(vat.toDate)} — generated from the books: Output VAT from the income accounts, Input VAT from the expense accounts. Click an account to see
              the documents behind it.
            </p>

            <h3 style={{ margin: 'var(--space-3) 0 var(--space-1)' }}>Output VAT — sales, by income account</h3>
            <AccountStatement rows={vat.statement.income.rows} totals={vat.statement.income} heads={['Sales (excl. VAT)', 'Output VAT', 'Total (incl. VAT)']} empty="No sales in this period — pick a wider date range above (for example Year to date)." />
            <p className="note" style={{ marginTop: 'var(--space-1)' }}>
              Walk-in sales {fmtKsh(vat.walkinSales)} · corporate sales {fmtKsh(vat.corporateSales)}
              {vat.debitNotes ? ` · debit notes ${fmtKsh(vat.debitNotes)}` : ''}
              {vat.creditNotes ? ` · credit notes −${fmtKsh(vat.creditNotes)}` : ''} (VAT-inclusive). Quotations are offers, not sales.
            </p>

            <h3 style={{ margin: 'var(--space-4) 0 var(--space-1)' }}>Outsourced services — VAT on the sale and on the supplier's bill</h3>
            <p className="note" style={{ marginTop: 0 }}>Already included in the income and expense figures above; shown here together so the two sides of contracted-out work can be compared.</p>
            <table className="table">
              <thead>
                <tr>
                  <th>Sale (output VAT)</th>
                  <th>Customer</th>
                  <th style={{ textAlign: 'right' }}>Sales (excl. VAT)</th>
                  <th style={{ textAlign: 'right' }}>Output VAT</th>
                  <th style={{ textAlign: 'right' }}>Supplier billed</th>
                </tr>
              </thead>
              <tbody>
                {vat.statement.outsourced.sales.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      No outsourced sales in this period.
                    </td>
                  </tr>
                )}
                {vat.statement.outsourced.sales.rows.map((r) => (
                  <tr key={r.orderId} style={{ cursor: 'pointer' }} onClick={() => setVatOrderId(r.orderId)}>
                    <td>
                      {r.orderNo} <span className="text-muted">{fmtDate(r.date)}</span>
                    </td>
                    <td>{r.customer}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.net)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.vat)}</td>
                    <td style={{ textAlign: 'right' }}>{r.billed > 0 ? fmtKsh(r.billed) : <span className="tag tag-outline">not billed yet{r.quoted > 0 ? ` (quote ${fmtKsh(r.quoted)})` : ''}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Outsourced sales</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(vat.statement.outsourced.sales.net)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(vat.statement.outsourced.sales.vat)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            <table className="table" style={{ marginTop: 'var(--space-3)' }}>
              <thead>
                <tr>
                  <th>Supplier bill (input VAT)</th>
                  <th>Order</th>
                  <th>Invoice #</th>
                  <th style={{ textAlign: 'right' }}>Cost (excl. VAT)</th>
                  <th style={{ textAlign: 'right' }}>Input VAT</th>
                </tr>
              </thead>
              <tbody>
                {vat.statement.outsourced.bills.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      No supplier bills in this period — record a supplier bill on the order to claim its VAT.
                    </td>
                  </tr>
                )}
                {vat.statement.outsourced.bills.rows.map((r) => (
                  <tr key={r.expenseId}>
                    <td>
                      {r.supplier || '—'} <span className="text-muted">{fmtDate(r.date)}</span>
                    </td>
                    <td>{r.orderNo ?? '—'}</td>
                    <td className="text-muted">{r.invoiceNumber || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.net)}</td>
                    <td style={{ textAlign: 'right' }}>{r.vat > 0 ? fmtKsh(r.vat) : <span className="text-muted">no VAT (head)</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Outsourced supplier bills</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(vat.statement.outsourced.bills.net)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(vat.statement.outsourced.bills.vat)}</td>
                </tr>
              </tfoot>
            </table>
            <p style={{ margin: 'var(--space-2) 0 0' }}>
              <b>VAT on outsourced work: {fmtKsh(vat.statement.outsourced.sales.vat)} output − {fmtKsh(vat.statement.outsourced.bills.vat)} input = {fmtKsh(vat.statement.outsourced.netVat)}</b>
            </p>

            <h3 style={{ margin: 'var(--space-4) 0 var(--space-1)' }}>Input VAT — purchases and expenses, by expense account</h3>
            <AccountStatement rows={vat.statement.expenses.rows} totals={vat.statement.expenses} heads={['Cost (excl. VAT)', 'Input VAT', 'Paid (incl. VAT)']} empty="No purchases or expenses in this period." />

            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'var(--space-4)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '8px 0', borderTop: '1px solid var(--color-divider)', fontFamily: 'var(--font-heading)' }}>
                <span>Output VAT (16%) — on sales</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.outputVat)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
                <span>Less: Input VAT — on purchases &amp; expenses</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>− {fmtKsh(vat.inputVat)}</span>
              </div>
              {vat.otherVat !== 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
                  <span>Other adjustments (manual journals)</span>
                  <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(vat.otherVat)}</span>
                </div>
              )}
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
                <span>{vat.netVatPayable < 0 ? 'VAT refundable / carried forward' : 'Net VAT payable to KRA'}</span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(Math.abs(vat.netVatPayable))}</span>
              </div>
            </div>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Output VAT is the 16% inside every sale price (walk-in orders and every corporate order past Quotation, less credit notes). Input VAT is the VAT in your purchases and expenses,
              set once per expense head (see below). Prices are VAT-inclusive.
            </p>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Purchases &amp; expenses — input VAT
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              Every purchase and expense in the period is here and its VAT counted automatically, by its expense head (see below) — nothing to tick. The VAT is 16/116 of what was
              paid. Keep the supplier's tax invoice for each one; a row marked <i>no invoice #</i> is counted but has no invoice number on file.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Invoice #</th>
                  <th style={{ textAlign: 'right' }}>Paid (incl. VAT)</th>
                  <th style={{ textAlign: 'right' }}>Input VAT</th>
                </tr>
              </thead>
              <tbody>
                {vat.purchases.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      No purchases or expenses in this period.
                    </td>
                  </tr>
                )}
                {vat.purchases.map((p) => (
                  <tr key={p.id}>
                    <td className="text-muted">{fmtDate(p.date)}</td>
                    <td>
                      {p.category}
                      {p.isStockPurchase && <span className="tag tag-outline" style={{ marginLeft: 6 }}>Stock</span>}
                      <div className="note" style={{ margin: 0 }}>
                        {[p.supplier, p.note].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="text-muted">{p.invoiceNumber || (p.vatAmount > 0 ? <span className="tag tag-outline">no invoice #</span> : '—')}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(p.amount)}</td>
                    <td style={{ textAlign: 'right', fontWeight: p.vatAmount ? 700 : undefined }}>{p.vatAmount ? fmtKsh(p.vatAmount) : <span className="text-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              VAT treatment by expense head
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              Set once for each kind of spending. Every purchase and expense under a head follows it — past and future — so the VAT figures above always reflect it. The standing
              answers: materials, stock, transport, utilities, repairs, supplies, courier, airtime/data, cleaning and outsourced services carry VAT; wages, bank charges, refreshments,
              commission and anything unrecognised do not.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Expense head</th>
                  <th style={{ width: 220 }}>Carries VAT (claimed back)</th>
                </tr>
              </thead>
              <tbody>
                {vat.heads.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {h.name} {!h.isDefault && <span className="tag tag-outline">set by you</span>}
                    </td>
                    <td>
                      <div className="seg" role="radiogroup" aria-label={`VAT on ${h.name}`}>
                        {(
                          [
                            [true, 'Yes'],
                            [false, 'No'],
                          ] as [boolean, string][]
                        ).map(([v, label]) => (
                          <label key={label} className={'seg-opt' + (h.applicable === v ? ' checked' : '')}>
                            <input type="radio" name={`vat-head-${h.id}`} checked={h.applicable === v} disabled={busy} onChange={() => setHeadVat(h.id, v)} />
                            {label}
                          </label>
                        ))}
                      </div>
                      {!h.isDefault && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setHeadVat(h.id, null)}>
                          back to standing answer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {vatOrderId != null && <OrderDetailDialog orderId={vatOrderId} onClose={() => setVatOrderId(null)} onChanged={load} />}

      {tab === 'employees' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
            Employee details
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            The identifiers payroll and the P9 need for each person: National ID (7 or 8 digits), KRA PIN (a letter, nine digits and a letter, like A123456789B) and SHIF registration
            number. They print on the payroll, payslips and P9. Names are kept under Master Data → Staff &amp; Users.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Role</th>
                <th>National ID</th>
                <th>KRA PIN</th>
                <th>SHIF No.</th>
                <th title="Gross monthly salary before deductions (basic plus fixed allowances). Sets the sales target for commission: 3 × this, by default">Gross salary (Ksh / month)</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    No staff yet.
                  </td>
                </tr>
              )}
              {employees.map((u) => {
                const draft = empDrafts[u.id];
                const incomplete = !u.nationalId || !u.kraPin || !u.shifNumber;
                return (
                  <tr key={u.id}>
                    <td>
                      {u.name} {incomplete && !draft && <span className="tag tag-outline">incomplete</span>}
                    </td>
                    <td>
                      <span className="tag tag-neutral">{u.role}</span>
                    </td>
                    {draft ? (
                      <>
                        <td>
                          <input className="input" style={{ width: 130 }} inputMode="numeric" value={draft.nationalId} onChange={(e) => setEmpDrafts((x) => ({ ...x, [u.id]: { ...x[u.id]!, nationalId: e.target.value } }))} placeholder="12345678" autoFocus />
                        </td>
                        <td>
                          <input className="input" style={{ width: 130 }} value={draft.kraPin} maxLength={11} onChange={(e) => setEmpDrafts((x) => ({ ...x, [u.id]: { ...x[u.id]!, kraPin: e.target.value.toUpperCase() } }))} placeholder="A123456789B" />
                        </td>
                        <td>
                          <input className="input" style={{ width: 150 }} value={draft.shifNumber} onChange={(e) => setEmpDrafts((x) => ({ ...x, [u.id]: { ...x[u.id]!, shifNumber: e.target.value } }))} placeholder="SHIF number" />
                        </td>
                        <td>
                          <input className="input" style={{ width: 120 }} inputMode="decimal" value={draft.basicSalary} onChange={(e) => setEmpDrafts((x) => ({ ...x, [u.id]: { ...x[u.id]!, basicSalary: e.target.value } }))} placeholder="e.g. 40000" />
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveEmployee(u.id)}>
                              Save
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEmpDrafts((x) => { const { [u.id]: _d, ...rest } = x; return rest; })}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{u.nationalId ?? <span className="text-muted">—</span>}</td>
                        <td>{u.kraPin ?? <span className="text-muted">—</span>}</td>
                        <td>{u.shifNumber ?? <span className="text-muted">—</span>}</td>
                        <td>{u.basicSalary ? u.basicSalary.toLocaleString('en-KE') : <span className="text-muted">—</span>}</td>
                        <td>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEmpDrafts((x) => ({ ...x, [u.id]: { nationalId: u.nationalId ?? '', kraPin: u.kraPin ?? '', shifNumber: u.shifNumber ?? '', basicSalary: u.basicSalary ? String(u.basicSalary) : '' } }))}>
                            {incomplete ? 'Add details' : 'Edit'}
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'p9' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-2)' }}>
            <div className="card-title">P9 — tax deduction card</div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Year</label>
                <input className="input" style={{ width: 100 }} inputMode="numeric" maxLength={4} value={p9Year} onChange={(e) => setP9Year(e.target.value.replace(/\D/g, ''))} />
              </div>
              <button type="button" className="btn btn-primary" disabled={!p9 || p9.employees.length === 0} onClick={() => printP9()}>
                Print all P9s (A4)
              </button>
            </div>
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            One A4 card per employee for the year: gross pay, statutory deductions, tax charged, personal relief and PAYE, month by month — worked out exactly as the payroll did when the pay was
            logged. Casual staff carry no PAYE, so they have no P9.
          </p>
          {p9 && !p9.employer.kraPin && (
            <p className="note" style={{ color: 'var(--color-error)' }}>
              The company's KRA PIN is not recorded — add it under Master Data → Company Info; it prints as the employer's PIN.
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>KRA PIN</th>
                <th>National ID</th>
                <th style={{ textAlign: 'right' }}>Gross pay for {p9Year}</th>
                <th style={{ textAlign: 'right' }}>PAYE for {p9Year}</th>
                <th style={{ width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {!p9 && (
                <tr>
                  <td colSpan={6} className="text-muted">
                    Loading…
                  </td>
                </tr>
              )}
              {p9 && p9.employees.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No pay was logged for employees in {p9.year}.
                  </td>
                </tr>
              )}
              {p9?.employees.map((e) => (
                <tr key={e.staff.id}>
                  <td>{e.staff.name}</td>
                  <td>{e.staff.kraPin ?? <span className="tag tag-accent">not recorded</span>}</td>
                  <td>{e.staff.nationalId ?? <span className="tag tag-accent">not recorded</span>}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(e.totals.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(e.totals.paye)}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => printP9(e.staff.id)}>
                      Print P9
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            6% of pay from the employee and the same again from the employer, on pay up to NSSF's Upper Earnings Limit (KES 108,000 from February 2026; 72,000 from February 2025). The employee's share is taken from their pay before PAYE is worked out; the employer's share is a cost to the business. Casual staff are excluded — not subject to statutory deductions.
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
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssfEmployer)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.nssf + r.nssfEmployer)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontFamily: 'var(--font-heading)' }}>
                <td colSpan={5} style={{ textAlign: 'right', paddingRight: 12 }}>
                  Total NSSF
                </td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(payroll.totalNssf + payroll.totalNssfEmployer)}</td>
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
            2.75% of gross pay (minimum Ksh 300), paid by the employee and taken from their pay before PAYE is worked out. Casual staff are excluded — not subject to statutory deductions.
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
          <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={printRegister}>
              Print payroll (A4)
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy || payroll.rows.length === 0} onClick={() => printPayslips(payroll.rows)}>
              Print all payslips ({payroll.rows.length})
            </button>
            <span className="note" style={{ alignSelf: 'center' }}>For the dates chosen above. Each pay entry also has its own Payslip button.</span>
          </div>
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

            <div style={{ display: 'grid', gridTemplateColumns: newEntry.employeeType === 'Employee' ? '1fr 1.2fr 0.8fr 1fr 1fr 1fr auto' : '1fr 1.2fr 0.8fr 1fr 0.7fr 0.7fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
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
              {newEntry.employeeType === 'Employee' ? (
                <div className="field">
                  <label>Monthly salary (Ksh)</label>
                  <input className="input" value={newEntry.grossPay} onChange={(e) => setNewEntry((ne) => ({ ...ne, grossPay: e.target.value }))} />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>Days</label>
                    <input className="input" value={newEntry.daysWorked} onChange={(e) => setNewEntry((ne) => ({ ...ne, daysWorked: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label>Rate (Ksh/day)</label>
                    <input className="input" value={newEntry.rate} onChange={(e) => setNewEntry((ne) => ({ ...ne, rate: e.target.value }))} />
                  </div>
                </>
              )}
              <div className="field">
                <label>Paid from</label>
                <div className="input" style={{ display: 'flex', alignItems: 'center' }}>Petty Cash (always)</div>
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
              Gross pay preview: {fmtKsh(grossPreview)}. Employees are paid a fixed monthly salary; Casuals stay
              day-rate. PAYE, NSSF, SHIF and Housing Levy are computed automatically for Employees — Casuals are not
              subject to statutory deductions. "Paid from Petty Cash" registers the net pay as an outflow against the
              Petty Cash float and is rejected if the float can't cover it. Staff names come from Master Data → Staff
              &amp; Users.
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
                    <th>Paid from</th>
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
                        <td className="text-muted">{r.paymentSource}</td>
                        <td className="text-muted">{r.capturedByName || '—'}</td>
                        <td className="no-print">
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => printPayslips([r])}>
                            Payslip
                          </button>
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
                        <DeleteReasonRow colSpan={13} reason={deleteReason} setReason={setDeleteReason} onSubmit={submitDeleteRequest} onCancel={() => setDeleteTarget(null)} busy={busy} />
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
    </div>
  );
}
