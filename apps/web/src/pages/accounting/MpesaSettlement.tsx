import { useState } from 'react';
import { fmtDate, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, Loading, Notice, money, numStyle, useLoad } from './shared';

// Accounting → M-Pesa → "Settled to the bank". What the Paybill collects (STK pushes and payments made straight to it) sits in the M-Pesa account until NCBA settles it into the bank
// account — every day. Record each settlement here from the bank statement: the amount that reached the bank, and any charge NCBA took. It moves the money from M-Pesa to Bank, so the
// M-Pesa balance falls back to what has not been settled yet and the bank balance agrees with the statement.

interface Data {
  balance: number;
  days: { date: string; received: number; settled: number }[];
  settlements: { id: number; ref: string; date: string; memo: string; createdByName: string; amount: number; charges: number }[];
}

export function MpesaSettlement() {
  const { user } = useAuth();
  const may = user?.role === 'Admin' || !!user?.permissions.canAccessAccounting;
  const { data, error, loading, reload } = useLoad<Data>(may ? '/accounting/mpesa/settlements' : null);
  const [date, setDate] = useState(todayStr());
  const [amount, setAmount] = useState('');
  const [charges, setCharges] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  if (!may) return null;

  const amt = Number(amount.replace(/[^\d.]/g, '')) || 0;
  const chg = Number(charges.replace(/[^\d.]/g, '')) || 0;

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.post('/accounting/mpesa/settlements', { date, amount: amt, charges: chg, reference });
      setMsg(`Recorded: ${money(amt)} to the bank${chg > 0 ? `, ${money(chg)} charges` : ''}.`);
      setAmount('');
      setCharges('');
      setReference('');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record the settlement');
    } finally {
      setBusy(false);
    }
  }
  async function reverse(id: number) {
    if (!window.confirm('Reverse this settlement? The money goes back to the M-Pesa account.')) return;
    setBusy(true);
    setErr('');
    try {
      await api.del(`/accounting/journals/${id}`);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Only an Admin can reverse a settlement');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Settled to the bank" hint="NCBA settles the Paybill into the bank account every day. Record each settlement from the bank statement so the M-Pesa and Bank balances agree with it.">
      <Loading loading={loading && !data} error={error} />
      <Notice error={err} message={msg} />
      {data && (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <div>
            <div className="card-kicker">In M-Pesa, not yet settled to the bank</div>
            <div className="card-title">{money(data.balance)}</div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Date it reached the bank</label>
              <input className="input" type="date" max={todayStr()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Settlement date" />
            </div>
            <div className="field" style={{ margin: 0, width: 160 }}>
              <label>Amount received (Ksh)</label>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount that reached the bank" />
            </div>
            <div className="field" style={{ margin: 0, width: 130 }}>
              <label>Charges taken (Ksh)</label>
              <input className="input" inputMode="decimal" placeholder="0" value={charges} onChange={(e) => setCharges(e.target.value)} aria-label="Charges NCBA took" />
            </div>
            <div className="field" style={{ margin: 0, width: 180 }}>
              <label>Bank reference (optional)</label>
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Bank reference" />
            </div>
            <button type="button" className="btn btn-primary" disabled={busy || amt <= 0} onClick={save}>
              Record settlement
            </button>
            {data.balance > 0.005 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmount(String(data.balance - chg))} title="Fill in the whole M-Pesa balance (less the charges)">
                Use the whole balance
              </button>
            )}
          </div>
          <p className="note" style={{ margin: 0 }}>The amount is what reached the bank; the charges are what NCBA took off it, taken out of M-Pesa as well. Together they cannot be more than is in M-Pesa.</p>

          {data.days.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <div className="card-kicker">Day by day</div>
              <table className="table" style={{ maxWidth: 520 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th style={numStyle}>Came into M-Pesa</th>
                    <th style={numStyle}>Settled to the bank</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date}>
                      <td>{fmtDate(d.date)}</td>
                      <td style={numStyle}>{d.received > 0 ? money(d.received) : '—'}</td>
                      <td style={numStyle}>{d.settled > 0 ? money(d.settled) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.settlements.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <div className="card-kicker">Recent settlements</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th>Details</th>
                    <th style={numStyle}>To the bank</th>
                    <th style={numStyle}>Charges</th>
                    <th>By</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.settlements.map((s) => (
                    <tr key={s.id}>
                      <td>{fmtDate(s.date)}</td>
                      <td className="text-muted">{s.ref}</td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{s.memo}</td>
                      <td style={numStyle}>{money(s.amount)}</td>
                      <td style={numStyle}>{s.charges > 0 ? money(s.charges) : '—'}</td>
                      <td className="text-muted">{s.createdByName}</td>
                      <td>
                        {user?.role === 'Admin' && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reverse(s.id)}>
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
