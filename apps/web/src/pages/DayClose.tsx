import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addDays, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from './accounting/shared';

// Finance → Day close: the daily reconciliation. What was received (by method and by person), the cash in each till counted against what the system says it should be (the cash-up), what NCBA says
// it took against what is on orders, and what customers still owe, aged by due date. The month view shows which days were closed and which were not. The Admin sets up tills and the evening WhatsApp
// summary at the bottom.

interface TillRow {
  id: number;
  name: string;
  isMain: boolean;
  openingFloat: number;
  received: number;
  refunds: number;
  expected: number;
  close: null | { status: 'Submitted' | 'Approved'; counted: number; variance: number; banked: number };
}

interface Day {
  date: string;
  tillId: number | null;
  today: string;
  amberUpTo: number;
  denominations: number[];
  tills: TillRow[];
  byMethod: { method: string; count: number; amount: number }[];
  received: number;
  byPerson: { person: string; cash: number; other: number; count: number }[];
  payments: { id: number; orderId: number; orderNo: string; customer: string; method: string; amount: number; reference: string; by: string }[];
  cash: { openingFloat: number; received: number; refunds: number; expected: number };
  outstanding: {
    opening: number;
    raisedToday: number;
    receivedToday: number;
    otherChanges: number;
    closing: number;
    bands: { label: string; count: number; amount: number }[];
    invoices: { id: number; orderNo: string; customer: string; createdDate: string; dueDate: string | null; balance: number; daysOverdue: number; staff: string }[];
    invoiceCount: number;
  };
  ncba: {
    active: boolean;
    sent: { count: number; amount: number };
    onOrders: { count: number; amount: number };
    notOnOrder: { count: number; amount: number; receipts: { id: number; receipt: string; amount: number; phone: string; payer: string; billRef: string; outcome: string }[] };
    otherMpesa: { count: number; amount: number; payments: { id: number; orderNo: string; customer: string; amount: number; reference: string }[] };
    duplicatesOrRejected: number;
    expectedBankSettlement: number;
  };
  close: null | {
    status: 'Submitted' | 'Approved';
    openingFloat: number;
    expectedCash: number;
    countedCash: number;
    variance: number;
    floatCarried: number;
    banked: number;
    denominations: Record<string, number> | null;
    note: string;
    submittedByName: string;
    submittedAt: string;
    approvedByName: string | null;
    approvedAt: string | null;
    changedSince: boolean;
  };
}

interface Month {
  month: string;
  amberUpTo: number;
  days: { date: string; received: number; cash: number; payments: number; status: string; notClosedTills: string[]; variance: number | null; counted: number | null; banked: number | null }[];
  notClosed: number;
  totalVariance: number;
  totalBanked: number;
}

const num = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(/,/g, '')) || 0);
const dayName = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function VarianceTag({ v, amber }: { v: number; amber: number }) {
  if (Math.abs(v) < 0.005) return <Tag tone="good">Balanced</Tag>;
  const label = `${v < 0 ? 'Short' : 'Over'} ${fmtKsh(Math.abs(v))}`;
  return Math.abs(v) <= amber ? <span className="tag tag-neutral" style={{ borderColor: 'var(--color-warning, #b7791f)', color: 'var(--color-warning, #b7791f)' }}>{label}</span> : <Tag tone="bad">{label}</Tag>;
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 'var(--space-3) var(--space-4)', flex: '1 1 180px' }}>
      <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.65 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, ...numStyle, textAlign: 'left' }}>{value}</div>
      {sub && <div className="note" style={{ margin: 0 }}>{sub}</div>}
    </div>
  );
}

export default function DayClose() {
  const { user } = useAuth();
  const p = user?.permissions;
  const canApprove = user?.role === 'Admin' || !!p?.canAccessFinance;
  const isAdmin = user?.role === 'Admin';
  const [params] = useSearchParams();
  const [view, setView] = useState<'day' | 'month'>('day');
  const [date, setDate] = useState(params.get('date') || todayStr());
  const [till, setTill] = useState(params.get('till') || ''); // '' = the main till, 'all', or a till id
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const day = useLoad<Day>(view === 'day' ? `/day-close?date=${date}${till ? `&till=${till}` : ''}` : null);
  const mon = useLoad<Month>(view === 'month' ? `/day-close/month?month=${month}` : null);

  const [counted, setCounted] = useState('');
  const [carried, setCarried] = useState('');
  const [note, setNote] = useState('');
  const [byNote, setByNote] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showPayments, setShowPayments] = useState(false);

  const d = day.data;
  const locked = d?.close?.status === 'Approved';
  const tillRow = d && d.tillId != null ? d.tills.find((t) => t.id === d.tillId) : undefined;
  const multi = (d?.tills.length ?? 0) > 1;
  // load the saved close (or a clean form) whenever the day or the till changes
  useEffect(() => {
    if (!d) return;
    const c = d.close;
    setCounted(c ? String(c.countedCash) : '');
    setCarried(c ? String(c.floatCarried) : '');
    setNote(c?.note ?? '');
    setByNote(!!c?.denominations);
    setNotes(Object.fromEntries(Object.entries(c?.denominations ?? {}).map(([k, v]) => [k, String(v)])));
    setError('');
    setMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.date, d?.tillId, d?.close?.status, d?.close?.submittedAt]);

  const noteTotal = useMemo(() => Object.entries(notes).reduce((a, [k, v]) => a + Number(k) * num(v), 0), [notes]);
  const countedNum = byNote ? noteTotal : num(counted);
  const expected = d?.cash.expected ?? 0;
  const variance = Math.round((countedNum - expected) * 100) / 100;
  const banked = Math.max(0, Math.round((countedNum - num(carried)) * 100) / 100);

  async function submit() {
    if (!d || d.tillId == null) return;
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await api.post('/day-close', {
        date: d.date,
        tillId: d.tillId,
        counted: countedNum,
        floatCarried: num(carried),
        note,
        denominations: byNote ? Object.fromEntries(Object.entries(notes).filter(([, v]) => num(v) > 0).map(([k, v]) => [k, Math.round(num(v))])) : undefined,
      });
      setMessage('The cash-up is saved and waiting for approval.');
      day.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the cash-up');
    } finally {
      setBusy(false);
    }
  }
  async function act(path: string, done: string) {
    if (!d || d.tillId == null) return;
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await api.post(path, { tillId: d.tillId });
      setMessage(done);
      day.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  const tillDot = (t: TillRow) => (t.close ? (t.close.status === 'Approved' ? '✔' : '●') : t.received + t.refunds > 0 && date < todayStr() ? '!' : '○');

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div>
          <div className="card-kicker">Finance</div>
          <div className="card-title">Day close</div>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={'btn ' + (view === 'day' ? 'btn-primary' : 'btn-secondary')} onClick={() => setView('day')}>Day sheet</button>
          <button type="button" className={'btn ' + (view === 'month' ? 'btn-primary' : 'btn-secondary')} onClick={() => setView('month')}>Month</button>
          {view === 'day' && (
            <>
              <button type="button" className="btn btn-ghost" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>◀</button>
              <input className="input" type="date" value={date} max={todayStr()} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160 }} />
              <button type="button" className="btn btn-ghost" aria-label="Next day" disabled={date >= todayStr()} onClick={() => setDate(addDays(date, 1))}>▶</button>
              <button type="button" className="btn btn-ghost" onClick={() => setDate(todayStr())}>Today</button>
              <button type="button" className="btn btn-secondary" onClick={() => window.print()}>🖶 Print</button>
            </>
          )}
          {view === 'month' && <input className="input" type="month" value={month} max={todayStr().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 160 }} />}
        </div>
      </div>
      <Notice error={error} message={message} />

      {view === 'day' && (
        <>
          <Loading loading={day.loading} error={day.error} />
          {d && (
            <>
              <p className="note" style={{ margin: 0 }}><b>{dayName(d.date)}</b>{multi && d.tillId != null && tillRow ? ` · ${tillRow.name}` : multi ? ' · all tills' : ''}</p>
              {multi && (
                <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="tablist" aria-label="Tills">
                  {d.tills.map((t) => (
                    <button key={t.id} type="button" role="tab" aria-selected={d.tillId === t.id} className={'btn ' + (d.tillId === t.id ? 'btn-primary' : 'btn-secondary')} onClick={() => setTill(String(t.id))}>
                      {tillDot(t)} {t.name}
                    </button>
                  ))}
                  <button type="button" role="tab" aria-selected={d.tillId == null} className={'btn ' + (d.tillId == null ? 'btn-primary' : 'btn-secondary')} onClick={() => setTill('all')}>All tills</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <Tile label="Received" value={fmtKsh(d.received)} sub={`${d.byMethod.reduce((a, m) => a + m.count, 0)} payments`} />
                <Tile label="Cash expected" value={fmtKsh(d.cash.expected)} sub={d.close ? `Counted ${fmtKsh(d.close.countedCash)}` : d.tillId == null ? `${d.tills.filter((t) => t.close).length} of ${d.tills.length} tills counted` : 'Not counted yet'} />
                <Tile
                  label="Cash-up"
                  value={d.close ? <VarianceTag v={d.close.variance} amber={d.amberUpTo} /> : d.tillId == null ? <Tag>{d.tills.every((t) => t.close) ? 'All closed' : 'Open'}</Tag> : <Tag>Not closed</Tag>}
                  sub={d.close ? (d.close.status === 'Approved' ? `Approved by ${d.close.approvedByName}` : `Waiting for approval · counted by ${d.close.submittedByName}`) : undefined}
                />
                <Tile label="Owed by customers" value={fmtKsh(d.outstanding.closing)} sub={`${d.outstanding.invoiceCount} invoices`} />
              </div>

              <Card title="Received, by method" hint="Every payment dated this day. Cash is counted below; the others are checked against the M-Pesa, NCBA, bank and card statements.">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Method</th><th style={numStyle}>Payments</th><th style={numStyle}>Amount</th></tr></thead>
                    <tbody>
                      {d.byMethod.filter((m) => m.count > 0 || m.method === 'Cash').map((m) => (
                        <tr key={m.method} style={m.method === 'Cash' ? { fontWeight: 700 } : undefined}>
                          <td>{m.method}</td>
                          <td style={numStyle}>{m.count}</td>
                          <td style={numStyle}>{fmtKsh(m.amount)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}><td>Total</td><td style={numStyle}>{d.byMethod.reduce((a, m) => a + m.count, 0)}</td><td style={numStyle}>{fmtKsh(d.received)}</td></tr>
                    </tbody>
                  </table>
                </div>
                {d.byPerson.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
                    <table className="table">
                      <thead><tr><th>Taken by</th><th style={numStyle}>Payments</th><th style={numStyle}>Cash</th><th style={numStyle}>Other methods</th></tr></thead>
                      <tbody>
                        {d.byPerson.map((r) => (
                          <tr key={r.person}><td>{r.person}</td><td style={numStyle}>{r.count}</td><td style={numStyle}>{fmtKsh(r.cash)}</td><td style={numStyle}>{fmtKsh(r.other)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {d.payments.length > 0 && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm no-print" style={{ marginTop: 'var(--space-2)' }} onClick={() => setShowPayments(!showPayments)}>
                      {showPayments ? 'Hide' : 'Show'} the {d.payments.length} payments
                    </button>
                    {showPayments && (
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Order</th><th>Customer</th><th>Method</th><th>Reference</th><th>By</th><th style={numStyle}>Amount</th></tr></thead>
                          <tbody>
                            {d.payments.map((x) => (
                              <tr key={x.id}><td>{x.orderNo}</td><td>{x.customer}</td><td>{x.method}</td><td>{x.reference}</td><td>{x.by}</td><td style={numStyle}>{fmtKsh(x.amount)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </Card>

              {d.tillId == null ? (
                <Card title="Cash-up, till by till" hint="Each till is counted and approved on its own. Open a till to count it.">
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Till</th><th style={numStyle}>Float</th><th style={numStyle}>Cash in</th><th style={numStyle}>Expected</th><th style={numStyle}>Counted</th><th>Difference</th><th>Status</th><th className="no-print" /></tr></thead>
                      <tbody>
                        {d.tills.map((t) => (
                          <tr key={t.id}>
                            <td>{t.name}</td>
                            <td style={numStyle}>{fmtKsh(t.openingFloat)}</td>
                            <td style={numStyle}>{fmtKsh(t.received - t.refunds)}</td>
                            <td style={numStyle}>{fmtKsh(t.expected)}</td>
                            <td style={numStyle}>{t.close ? fmtKsh(t.close.counted) : '—'}</td>
                            <td>{t.close ? <VarianceTag v={t.close.variance} amber={d.amberUpTo} /> : '—'}</td>
                            <td>{t.close ? (t.close.status === 'Approved' ? <Tag tone="good">Approved</Tag> : <Tag>Waiting for approval</Tag>) : <Tag>Not closed</Tag>}</td>
                            <td className="no-print"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setTill(String(t.id))}>Open</button></td>
                          </tr>
                        ))}
                        <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}>
                          <td>All tills</td>
                          <td style={numStyle}>{fmtKsh(d.cash.openingFloat)}</td>
                          <td style={numStyle}>{fmtKsh(d.cash.received - d.cash.refunds)}</td>
                          <td style={numStyle}>{fmtKsh(d.cash.expected)}</td>
                          <td style={numStyle}>{fmtKsh(d.tills.reduce((a, t) => a + (t.close?.counted ?? 0), 0))}</td>
                          <td colSpan={3} />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card title={multi && tillRow ? `Cash-up — ${tillRow.name}` : 'Cash-up'} hint="Count the drawer, enter what is there, say how much stays as tomorrow’s float; the rest is banked. Someone other than the counter approves it.">
                  <div className="table-wrap" style={{ maxWidth: 520 }}>
                    <table className="table">
                      <tbody>
                        <tr><td>Float from the last close</td><td style={numStyle}>{fmtKsh(d.cash.openingFloat)}</td></tr>
                        <tr><td>+ Cash received today</td><td style={numStyle}>{fmtKsh(d.cash.received)}</td></tr>
                        <tr><td>− Cash refunded today</td><td style={numStyle}>{fmtKsh(d.cash.refunds)}</td></tr>
                        <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}><td>Cash that should be in the drawer</td><td style={numStyle}>{fmtKsh(d.cash.expected)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  {d.close?.changedSince && (
                    <Notice error={`Payments for this day were added or removed after it was closed. At the close the cash expected was ${fmtKsh(d.close.expectedCash)}; now it is ${fmtKsh(d.cash.expected)}. Ask an Admin to reopen the day and count again.`} />
                  )}
                  <fieldset disabled={locked || busy} style={{ border: 'none', padding: 0, margin: 'var(--space-3) 0 0' }}>
                    <label className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                      <input type="checkbox" checked={byNote} onChange={(e) => setByNote(e.target.checked)} /> Count the notes and coins one by one
                    </label>
                    {byNote ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--space-2)', maxWidth: 640 }}>
                        {d.denominations.map((den) => (
                          <div key={den} className="field">
                            <label>{den.toLocaleString('en-KE')} ×</label>
                            <input className="input" inputMode="numeric" value={notes[String(den)] ?? ''} onChange={(e) => setNotes({ ...notes, [String(den)]: e.target.value.replace(/\D/g, '') })} placeholder="0" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="field" style={{ maxWidth: 240 }}>
                        <label>Cash counted (Ksh)</label>
                        <input className="input" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0" />
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 'var(--space-2)' }}>
                      <div className="field" style={{ maxWidth: 240 }}>
                        <label>Float left for tomorrow (Ksh)</label>
                        <input className="input" inputMode="decimal" value={carried} onChange={(e) => setCarried(e.target.value)} placeholder="0" />
                      </div>
                      <div><div className="note" style={{ margin: 0 }}>Counted</div><b style={numStyle}>{fmtKsh(countedNum)}</b></div>
                      <div><div className="note" style={{ margin: 0 }}>To the bank</div><b style={numStyle}>{fmtKsh(banked)}</b></div>
                      <div><div className="note" style={{ margin: 0 }}>Difference</div>{!byNote && counted.trim() === '' ? '—' : <VarianceTag v={variance} amber={d.amberUpTo} />}</div>
                    </div>
                    <div className="field" style={{ maxWidth: 520, marginTop: 'var(--space-2)' }}>
                      <label>Note (optional)</label>
                      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. 50 short — change given wrongly to a walk-in customer" />
                    </div>
                  </fieldset>
                  <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)', alignItems: 'center' }}>
                    {!locked && (
                      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || (!byNote && counted.trim() === '')}>
                        {d.close ? 'Save the count again' : 'Submit the cash-up'}
                      </button>
                    )}
                    {d.close?.status === 'Submitted' && canApprove && (
                      <button type="button" className="btn btn-secondary" onClick={() => act(`/day-close/${d.date}/approve`, 'Approved. The day is locked.')} disabled={busy}>
                        ✔ Approve the day
                      </button>
                    )}
                    {locked && isAdmin && (
                      <button type="button" className="btn btn-ghost" onClick={() => act(`/day-close/${d.date}/reopen`, 'The day is open again.')} disabled={busy}>
                        Reopen the day
                      </button>
                    )}
                    {d.close && <Tag tone={locked ? 'good' : 'neutral'}>{locked ? `Approved by ${d.close.approvedByName}` : 'Waiting for approval'}</Tag>}
                  </div>
                </Card>
              )}

              {d.ncba.active && (
                <Card title="M-Pesa and NCBA tie-out" hint="What NCBA says it took on this day against what is recorded on orders. NCBA settles what it took into the bank account daily, so the total is what the bank should show. This is for the whole business, not one till.">
                  <div className="table-wrap" style={{ maxWidth: 560 }}>
                    <table className="table">
                      <tbody>
                        <tr style={{ fontWeight: 700 }}><td>NCBA sent ({d.ncba.sent.count} receipts)</td><td style={numStyle}>{fmtKsh(d.ncba.sent.amount)}</td></tr>
                        <tr><td>… on orders ({d.ncba.onOrders.count})</td><td style={numStyle}>{fmtKsh(d.ncba.onOrders.amount)}</td></tr>
                        <tr><td>… not on any order yet ({d.ncba.notOnOrder.count})</td><td style={numStyle}>{fmtKsh(d.ncba.notOnOrder.amount)}</td></tr>
                        <tr style={{ borderTop: '2px solid var(--color-divider)' }}><td>Expected in the bank from NCBA</td><td style={numStyle}>{fmtKsh(d.ncba.expectedBankSettlement)}</td></tr>
                        <tr><td>M-Pesa payments recorded that NCBA did not send ({d.ncba.otherMpesa.count})</td><td style={numStyle}>{fmtKsh(d.ncba.otherMpesa.amount)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  {d.ncba.duplicatesOrRejected > 0 && <p className="note">NCBA also sent {d.ncba.duplicatesOrRejected} duplicate or rejected notification(s), which are not counted.</p>}
                  {d.ncba.notOnOrder.receipts.length > 0 && (
                    <>
                      <p className="note" style={{ marginBottom: 0 }}><b>Money NCBA took with no sale against it yet</b> — match each to an order (Accounting → M-Pesa Matching) or find out who paid.</p>
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Receipt</th><th>Payer</th><th>Phone</th><th>Account given</th><th>NCBA outcome</th><th style={numStyle}>Amount</th></tr></thead>
                          <tbody>
                            {d.ncba.notOnOrder.receipts.map((r) => (
                              <tr key={r.id}><td>{r.receipt}</td><td>{r.payer}</td><td>{r.phone}</td><td>{r.billRef}</td><td>{r.outcome}</td><td style={numStyle}>{fmtKsh(r.amount)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  {d.ncba.otherMpesa.payments.length > 0 && (
                    <>
                      <p className="note" style={{ marginBottom: 0 }}><b>M-Pesa payments on orders that NCBA never sent</b> — a wrong or made-up code, or money paid to another number or till. Check each against the M-Pesa statement.</p>
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Order</th><th>Customer</th><th>Code on the order</th><th style={numStyle}>Amount</th></tr></thead>
                          <tbody>
                            {d.ncba.otherMpesa.payments.map((x) => (
                              <tr key={x.id}><td>{x.orderNo}</td><td>{x.customer}</td><td>{x.reference || '—'}</td><td style={numStyle}>{fmtKsh(x.amount)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </Card>
              )}

              <Card title="Still to be received" hint="Invoices with a balance at the end of this day, aged by due date. This is for the whole business.">
                <div className="table-wrap" style={{ maxWidth: 560 }}>
                  <table className="table">
                    <tbody>
                      <tr><td>Owed at the end of the day before</td><td style={numStyle}>{fmtKsh(d.outstanding.opening)}</td></tr>
                      <tr><td>+ Sales raised today</td><td style={numStyle}>{fmtKsh(d.outstanding.raisedToday)}</td></tr>
                      <tr><td>− Money received today</td><td style={numStyle}>{fmtKsh(d.outstanding.receivedToday)}</td></tr>
                      {Math.abs(d.outstanding.otherChanges) > 0.009 && <tr><td>± Credit notes and other changes</td><td style={numStyle}>{fmtKsh(d.outstanding.otherChanges)}</td></tr>}
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}><td>Owed at the end of today</td><td style={numStyle}>{fmtKsh(d.outstanding.closing)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="table-wrap" style={{ marginTop: 'var(--space-3)', maxWidth: 560 }}>
                  <table className="table">
                    <thead><tr><th>Age</th><th style={numStyle}>Invoices</th><th style={numStyle}>Amount</th></tr></thead>
                    <tbody>
                      {d.outstanding.bands.map((b) => (
                        <tr key={b.label}><td>{b.label}</td><td style={numStyle}>{b.count}</td><td style={numStyle}>{fmtKsh(b.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.outstanding.invoices.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
                    <table className="table">
                      <thead><tr><th>Invoice</th><th>Customer</th><th>Raised</th><th>Due</th><th style={numStyle}>Days overdue</th><th>Sales person</th><th style={numStyle}>Balance</th></tr></thead>
                      <tbody>
                        {d.outstanding.invoices.map((i) => (
                          <tr key={i.id}>
                            <td>{i.orderNo}</td>
                            <td>{i.customer}</td>
                            <td>{i.createdDate}</td>
                            <td>{i.dueDate ?? '—'}</td>
                            <td style={numStyle}>{i.daysOverdue > 0 ? i.daysOverdue : '—'}</td>
                            <td>{i.staff}</td>
                            <td style={numStyle}>{fmtKsh(i.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {d.outstanding.invoiceCount > d.outstanding.invoices.length && <p className="note">Showing the {d.outstanding.invoices.length} most overdue of {d.outstanding.invoiceCount} invoices.</p>}
                  </div>
                )}
              </Card>
              {isAdmin && <DayCloseSetup onChanged={day.reload} />}
            </>
          )}
        </>
      )}

      {view === 'month' && (
        <>
          <Loading loading={mon.loading} error={mon.error} />
          {mon.data && (
            <>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <Tile label="Days not closed" value={mon.data.notClosed} sub={mon.data.notClosed ? 'Days with cash received but no cash-up' : 'Every day with cash was closed'} />
                <Tile label="Net cash variance" value={fmtKsh(mon.data.totalVariance)} sub="Counted − expected, closed days" />
                <Tile label="Banked from cash" value={fmtKsh(mon.data.totalBanked)} />
              </div>
              <Card title={`Days in ${mon.data.month}`} hint="Click a day to open its sheet.">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Date</th><th style={numStyle}>Received</th><th style={numStyle}>Cash</th><th style={numStyle}>Counted</th><th>Difference</th><th>Status</th></tr></thead>
                    <tbody>
                      {mon.data.days.length === 0 && <tr><td colSpan={6} className="text-muted">No payments this month.</td></tr>}
                      {mon.data.days.map((x) => (
                        <tr key={x.date} style={{ cursor: 'pointer' }} onClick={() => { setDate(x.date); setView('day'); }}>
                          <td>{dayName(x.date)}</td>
                          <td style={numStyle}>{fmtKsh(x.received)}</td>
                          <td style={numStyle}>{fmtKsh(x.cash)}</td>
                          <td style={numStyle}>{x.counted == null ? '—' : fmtKsh(x.counted)}</td>
                          <td>{x.variance == null ? '—' : <VarianceTag v={x.variance} amber={mon.data!.amberUpTo} />}</td>
                          <td>
                            {x.status === 'Approved' ? <Tag tone="good">Approved</Tag> : x.status === 'Not closed' ? <Tag tone="bad">Not closed{x.notClosedTills.length ? ` — ${x.notClosedTills.join(', ')}` : ''}</Tag> : <Tag>{x.status === 'Submitted' ? 'Waiting for approval' : x.status}</Tag>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

// ── Set-up (Admin): tills and the evening summary ───────────────────────────
interface TillsData {
  tills: { id: number; name: string; isMain: boolean; active: boolean; people: number }[];
  people: { id: number; name: string; role: string; tillId: number | null }[];
}
interface SummarySettings {
  enabled: boolean;
  time: string;
  numbers: string;
  template: string;
  lastDate: string;
  lastStatus: string;
  templateBody: string;
  recipients: string[];
  nowNairobi: { date: string; time: string };
}

function DayCloseSetup({ onChanged }: { onChanged: () => void }) {
  const tills = useLoad<TillsData>('/day-close/tills');
  const settings = useLoad<SummarySettings>('/day-close/settings');
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('18:30');
  const [numbers, setNumbers] = useState('');
  const [template, setTemplate] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setEnabled(s.enabled);
    setTime(s.time);
    setNumbers(s.numbers);
    setTemplate(s.template);
  }, [settings.data]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await fn();
      setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  const t = tills.data;
  return (
    <details className="no-print">
      <summary style={{ cursor: 'pointer', fontWeight: 700, margin: 'var(--space-3) 0' }}>Set-up (Admin): tills and the evening WhatsApp summary</summary>
      <Notice error={error} message={message} />
      <Card title="Tills" hint="Each till is a cash drawer counted and approved on its own. Everyone takes cash at the main till unless you assign them to another; a payment goes to the till of the person who took it.">
        <Loading loading={tills.loading} error={tills.error} />
        {t && (
          <>
            <div className="table-wrap" style={{ maxWidth: 560 }}>
              <table className="table">
                <thead><tr><th>Till</th><th style={numStyle}>People</th><th /></tr></thead>
                <tbody>
                  {t.tills.map((x) => (
                    <tr key={x.id}>
                      <td>{x.name}{x.isMain ? ' (main)' : ''}{!x.active ? ' — switched off' : ''}</td>
                      <td style={numStyle}>{x.people}</td>
                      <td>
                        {!x.isMain && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.put(`/day-close/tills/${x.id}`, { active: !x.active }); tills.reload(); onChanged(); }, x.active ? 'Till switched off.' : 'Till switched on.')}>
                            {x.active ? 'Switch off' : 'Switch on'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end', margin: 'var(--space-3) 0' }}>
              <div className="field" style={{ maxWidth: 260 }}>
                <label>New till</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Workshop till" />
              </div>
              <button type="button" className="btn btn-secondary" disabled={busy || !name.trim()} onClick={() => run(async () => { await api.post('/day-close/tills', { name: name.trim() }); setName(''); tills.reload(); onChanged(); }, 'Till added.')}>Add the till</button>
            </div>
            <div className="table-wrap" style={{ maxWidth: 560 }}>
              <table className="table">
                <thead><tr><th>Person</th><th>Role</th><th>Takes cash at</th></tr></thead>
                <tbody>
                  {t.people.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td>{u.role}</td>
                      <td>
                        <select className="input" value={u.tillId ?? t.tills.find((x) => x.isMain)?.id ?? ''} disabled={busy} onChange={(e) => run(async () => { await api.put('/day-close/tills/assign', { userId: u.id, tillId: Number(e.target.value) }); tills.reload(); onChanged(); }, `${u.name} moved.`)}>
                          {t.tills.filter((x) => x.active || x.id === u.tillId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="Evening WhatsApp summary" hint="Each evening the day’s figures go to the numbers below: what came in, the cash-up result, what is owed, the NCBA tie-out and any day not closed.">
        <Loading loading={settings.loading} error={settings.error} />
        {settings.data && (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 'var(--space-2)' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send the summary every evening
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <div className="field" style={{ width: 140 }}>
                <label>Time (Nairobi)</label>
                <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <div className="field" style={{ flex: '1 1 280px', maxWidth: 420 }}>
                <label>Send to (WhatsApp numbers, separated by commas)</label>
                <input className="input" value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="0797 785 033, 0722 111 222" />
              </div>
              <div className="field" style={{ flex: '1 1 220px', maxWidth: 300 }}>
                <label>Template name (optional)</label>
                <input className="input" value={template} onChange={(e) => setTemplate(e.target.value.toLowerCase())} placeholder="glm_day_summary" />
              </div>
            </div>
            <p className="note">
              A message the business starts needs an approved template (WhatsApp Manager → Message templates → Utility, <b>no header</b>, body exactly: <code style={{ overflowWrap: 'anywhere' }}>{settings.data.templateBody}</code>). With no template the summary goes as a plain message, which WhatsApp delivers only to someone who has written to the business number in the last 24 hours.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(async () => { await api.put('/day-close/settings', { enabled, time, numbers, template }); settings.reload(); }, 'Saved.')}>Save</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(async () => { const r = await api.get<{ text: string }>(`/day-close/summary/preview?date=${todayStr()}`); setPreview(r.text); }, 'This is what today’s summary looks like.')}>Preview today’s summary</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ sent: string[] }>('/day-close/summary/send', { date: todayStr() }); setMessage(`Sent to ${r.sent.length} number(s).`); settings.reload(); }, '')}>Send it now</button>
            </div>
            {preview && <pre style={{ whiteSpace: 'pre-wrap', margin: 'var(--space-3) 0 0', padding: 'var(--space-3)', border: '1px solid var(--color-divider)' }}>{preview}</pre>}
            <p className="note">
              Nairobi time now: {settings.data.nowNairobi.time}. Last summary: {settings.data.lastDate ? `${settings.data.lastDate} — ${settings.data.lastStatus}` : 'none yet'}. A failed send is tried again every half hour, up to three times.
            </p>
          </>
        )}
      </Card>
    </details>
  );
}
