import { Fragment, useEffect, useState } from 'react';
import { EMPLOYEE_TYPES, PAYROLL_PAYMENT_SOURCES, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import type { EmployeeType, PayrollPaymentSource } from '@glm/shared';
import { api } from '../api/client';
import type { DeletableRecordType, DeletionRequest, PayrollData, VatData } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import DeleteReasonRow from '../components/DeleteReasonRow';
import DeletionRequestsCard from '../components/DeletionRequestsCard';

type ComplianceTab = 'vat' | 'nssf' | 'shif' | 'payroll';
type Preset = 'month' | 'quarter' | 'year' | 'last12';

const TABS: [ComplianceTab, string][] = [
  ['vat', 'VAT'],
  ['nssf', 'NSSF'],
  ['shif', 'SHIF'],
  ['payroll', 'Payroll'],
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

export default function Compliance() {
  const today = todayStr();
  const initial = presetRange('month', today);
  const { staff } = useCatalog();
  const [tab, setTab] = useState<ComplianceTab>('vat');
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [vat, setVat] = useState<VatData | null>(null);
  const [payroll, setPayroll] = useState<PayrollData | null>(null);
  const [deletionRequests, setDeletionRequests] = useState<DeletionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const staffOnly = staff.filter((s) => s.role === 'Staff');

  const [newEntry, setNewEntry] = useState({
    date: today,
    staffId: null as number | null,
    employeeType: 'Employee' as EmployeeType,
    department: '',
    grossPay: '',
    daysWorked: '',
    rate: '',
    paymentSource: 'Bank/Cheque' as PayrollPaymentSource,
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
                <select className="input" value={newEntry.paymentSource} onChange={(e) => setNewEntry((ne) => ({ ...ne, paymentSource: e.target.value as PayrollPaymentSource }))}>
                  {PAYROLL_PAYMENT_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
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
