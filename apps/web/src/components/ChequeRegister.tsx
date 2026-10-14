import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';

// Finance → Cheques: every cheque number used, whether it has cleared the bank, and where each cash withdrawal went. A cheque drawn to the finance head and cashed for the float is a
// Withdrawal (recorded as a Bank Withdrawal top-up in Petty Cash); a cheque written to a supplier is a Payment (recorded on the expense, with Cheque as the way it was paid); a number
// that was spoilt or cancelled is kept here too, so the cheque book has no unexplained gaps. Tick a cheque cleared when you see it on the bank statement.

interface Cheque {
  id: number;
  chequeNo: string;
  date: string;
  payee: string;
  amount: number;
  kind: 'Withdrawal' | 'Payment' | 'Cancelled';
  status: 'Issued' | 'Cleared' | 'Cancelled';
  clearedOn: string | null;
  note: string;
  topUpId: number | null;
  expenseId: number | null;
  capturedByName: string;
}
interface Withdrawal {
  topUpId: number;
  date: string;
  amount: number;
  note: string;
  chequeNo: string | null;
  payee: string;
  spent: number;
  remaining: number;
  breakdown: Record<'Salaries' | 'Purchases' | 'Expenses' | 'Other', number>;
  items: { date: string; label: string; amount: number; group: string }[];
}
interface Register {
  cheques: Cheque[];
  unpresented: { count: number; amount: number };
  clearedThisMonth: { count: number; amount: number };
  withdrawals: Withdrawal[];
  unallocated: number;
  withoutNumber: number;
}

const R = { textAlign: 'right' } as const;
type Filter = 'all' | 'Issued' | 'Cleared' | 'Cancelled';

export default function ChequeRegister() {
  const [d, setD] = useState<Register | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('Issued');
  const [q, setQ] = useState('');
  const [clearing, setClearing] = useState<{ id: number; on: string } | null>(null);
  const [numbering, setNumbering] = useState<{ topUpId: number; chequeNo: string; payee: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [spoilt, setSpoilt] = useState({ chequeNo: '', date: todayStr(), note: '' });

  const load = useCallback(() => {
    api
      .get<Register>('/finance/cheques')
      .then((r) => {
        setD(r);
        setErr('');
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the cheques'));
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not save');
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const term = q.trim().toUpperCase().replace(/\s+/g, '');
    return (d?.cheques ?? []).filter((c) => (filter === 'all' || c.status === filter) && (!term || c.chequeNo.includes(term) || c.payee.toUpperCase().includes(q.trim().toUpperCase()) || c.note.toUpperCase().includes(q.trim().toUpperCase())));
  }, [d, filter, q]);

  if (!d) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;

  const corners = (
    <>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
    </>
  );
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {err && <p className="note" role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</p>}

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {[
          ['Not yet cleared (unpresented)', `${fmtKsh(d.unpresented.amount)} · ${d.unpresented.count} cheque${d.unpresented.count === 1 ? '' : 's'}`],
          ['Cleared this month', `${fmtKsh(d.clearedThisMonth.amount)} · ${d.clearedThisMonth.count}`],
          ['Withdrawals with no cheque number', String(d.withoutNumber)],
        ].map(([label, value]) => (
          <div key={label} className="card blueprint" style={{ padding: 'var(--space-3) var(--space-4)', minWidth: 230 }}>
            <div className="card-kicker">{label}</div>
            <div className="card-title">{value}</div>
          </div>
        ))}
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Where the cash withdrawals went</div>
        <p className="note" style={{ marginTop: 0 }}>
          A cheque drawn to the finance head and cashed for the float. Money in the float is pooled, so the oldest money is taken to be spent first: each salary, purchase and expense paid from petty cash is shared between the withdrawals, oldest first. A cheque cashed for several purposes shows how much of it went to each, and what is left.
          {d.unallocated > 0 ? ` ${fmtKsh(d.unallocated)} paid from petty cash had no withdrawal on record before it (an opening balance).` : ''}
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Cheque</th>
                <th>Date</th>
                <th style={R}>Amount</th>
                <th style={R}>Salaries</th>
                <th style={R}>Purchases</th>
                <th style={R}>Expenses</th>
                <th style={R}>Other</th>
                <th style={R}>Left</th>
              </tr>
            </thead>
            <tbody>
              {d.withdrawals.map((w) => (
                <Fragment key={w.topUpId}>
                  <tr role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === w.topUpId ? null : w.topUpId)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(open === w.topUpId ? null : w.topUpId)}>
                    <td>
                      <span className="text-muted">{open === w.topUpId ? '▾' : '▸'}</span> {w.chequeNo ? <b>{w.chequeNo}</b> : <span className="tag tag-outline" style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }}>no number</span>}
                      <div className="note" style={{ margin: 0 }}>{[w.payee && `to ${w.payee}`, w.note].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>{fmtDate(w.date)}</td>
                    <td style={R}>{fmtKsh(w.amount)}</td>
                    <td style={R}>{w.breakdown.Salaries > 0 ? fmtKsh(w.breakdown.Salaries) : '—'}</td>
                    <td style={R}>{w.breakdown.Purchases > 0 ? fmtKsh(w.breakdown.Purchases) : '—'}</td>
                    <td style={R}>{w.breakdown.Expenses > 0 ? fmtKsh(w.breakdown.Expenses) : '—'}</td>
                    <td style={R}>{w.breakdown.Other > 0 ? fmtKsh(w.breakdown.Other) : '—'}</td>
                    <td style={{ ...R, fontWeight: 700 }}>{fmtKsh(w.remaining)}</td>
                  </tr>
                  {open === w.topUpId && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--color-surface)' }}>
                        {!w.chequeNo && (
                          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-2)' }}>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Cheque number</label>
                              <input className="input" value={numbering?.topUpId === w.topUpId ? numbering.chequeNo : ''} onChange={(e) => setNumbering({ topUpId: w.topUpId, chequeNo: e.target.value, payee: numbering?.topUpId === w.topUpId ? numbering.payee : '' })} />
                            </div>
                            <div className="field" style={{ margin: 0 }}>
                              <label>Drawn to</label>
                              <input className="input" value={numbering?.topUpId === w.topUpId ? numbering.payee : ''} onChange={(e) => setNumbering({ topUpId: w.topUpId, chequeNo: numbering?.topUpId === w.topUpId ? numbering.chequeNo : '', payee: e.target.value })} />
                            </div>
                            <button type="button" className="btn btn-primary btn-sm" disabled={busy || numbering?.topUpId !== w.topUpId || !numbering.chequeNo.trim()} onClick={() => run(async () => { await api.patch(`/finance/petty-cash/topups/${w.topUpId}/cheque`, { chequeNo: numbering!.chequeNo, payee: numbering!.payee }); setNumbering(null); })}>
                              Put the number on it
                            </button>
                          </div>
                        )}
                        {w.items.length === 0 ? (
                          <p className="note" style={{ margin: 0 }}>Nothing has been paid out of this withdrawal yet.</p>
                        ) : (
                          <table className="table">
                            <tbody>
                              {w.items.map((it, i) => (
                                <tr key={i}>
                                  <td style={{ width: 110 }}>{fmtDate(it.date)}</td>
                                  <td>{it.label}</td>
                                  <td style={{ width: 110 }}><span className="tag tag-neutral">{it.group}</span></td>
                                  <td style={{ ...R, width: 130 }}>{fmtKsh(it.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {d.withdrawals.length === 0 && <p className="note">No cash withdrawals yet. Record one under Petty Cash → Feed petty cash, with Bank Withdrawal as the source and the cheque number.</p>}
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
          <div className="card-title" style={{ flex: '1 1 160px' }}>The cheque register</div>
          <div className="seg" role="radiogroup" aria-label="Status">
            {(['Issued', 'Cleared', 'Cancelled', 'all'] as Filter[]).map((f) => (
              <label key={f} className={'seg-opt' + (filter === f ? ' checked' : '')}>
                <input type="radio" name="chqfilter" checked={filter === f} onChange={() => setFilter(f)} />
                {f === 'Issued' ? 'Not cleared' : f === 'all' ? 'All' : f}
              </label>
            ))}
          </div>
          <div className="field" style={{ margin: 0, width: 220 }}>
            <label>Find a cheque</label>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="number, payee or note" />
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Cheque no.</th>
                <th>Date</th>
                <th>Payee / purpose</th>
                <th>Type</th>
                <th style={R}>Amount</th>
                <th>Bank</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.chequeNo}</b></td>
                  <td>{fmtDate(c.date)}</td>
                  <td>
                    {c.payee || '—'}
                    {c.note && <div className="note" style={{ margin: 0 }}>{c.note}</div>}
                  </td>
                  <td>{c.kind === 'Withdrawal' ? 'Cash withdrawal' : c.kind === 'Payment' ? 'Payment' : 'Spoilt / cancelled'}</td>
                  <td style={R}>{c.kind === 'Cancelled' ? '—' : fmtKsh(c.amount)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {c.status === 'Cancelled' ? (
                      <>
                        <span className="tag tag-neutral">cancelled</span>{' '}
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => window.confirm(`Remove cheque ${c.chequeNo} from the register?`) && run(() => api.del(`/finance/cheques/${c.id}`))}>Remove</button>
                      </>
                    ) : c.status === 'Cleared' ? (
                      <>
                        <span className="tag tag-accent">cleared {c.clearedOn ? fmtDate(c.clearedOn) : ''}</span>{' '}
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.post(`/finance/cheques/${c.id}/unclear`))}>Undo</button>
                      </>
                    ) : clearing?.id === c.id ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input className="input" type="date" style={{ width: 150 }} value={clearing.on} min={c.date} max={todayStr()} onChange={(e) => setClearing({ id: c.id, on: e.target.value })} />
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !clearing.on} onClick={() => run(async () => { await api.post(`/finance/cheques/${c.id}/clear`, { clearedOn: clearing.on }); setClearing(null); })}>Cleared</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearing(null)}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        <span className="tag tag-outline">not cleared</span>{' '}
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setClearing({ id: c.id, on: todayStr() })}>Mark cleared</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="note">No cheques here.</p>}
        </div>

        <div style={{ marginTop: 'var(--space-3)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)' }}>
          <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>A spoilt or cancelled cheque</div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Cheque number</label>
              <input className="input" value={spoilt.chequeNo} onChange={(e) => setSpoilt({ ...spoilt, chequeNo: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Date</label>
              <input className="input" type="date" value={spoilt.date} max={todayStr()} onChange={(e) => setSpoilt({ ...spoilt, date: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0, flex: '1 1 220px' }}>
              <label>Why</label>
              <input className="input" value={spoilt.note} onChange={(e) => setSpoilt({ ...spoilt, note: e.target.value })} placeholder="e.g. spoilt, wrong date" />
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !spoilt.chequeNo.trim()} onClick={() => run(async () => { await api.post('/finance/cheques', spoilt); setSpoilt({ chequeNo: '', date: todayStr(), note: '' }); })}>
              Keep it in the register
            </button>
          </div>
        </div>
      </div>
      <p className="note" style={{ margin: 0 }}>
        Cheque numbers are recorded where the money is recorded: a cash withdrawal under <b>Petty Cash → Feed petty cash</b> (source Bank Withdrawal), and a cheque written to a supplier on the <b>expense</b> (paid by Cheque) or on the payment of a bill. No number can be used twice. Mark a cheque <b>cleared</b> when you see it on the bank statement; the ones still not cleared are the unpresented cheques for the bank reconciliation.
      </p>
    </div>
  );
}
