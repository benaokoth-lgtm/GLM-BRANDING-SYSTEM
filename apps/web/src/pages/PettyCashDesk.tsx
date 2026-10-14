import { useEffect, useState } from 'react';
import { PETTY_CASH_METHOD, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { PettyCashData } from '../api/models';
import { numStyle } from './accounting/shared';

// Petty Cash (the front office): see how much is in the float and log what is paid out of it. Feeding the float (a top-up from the bank, the cash sales or the owner) and removing an entry stay with
// Finance, who see the same figures under Finance → Petty Cash.

const month = () => todayStr().slice(0, 7);

export default function PettyCashDesk() {
  const [from, setFrom] = useState(month() + '-01');
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState<(PettyCashData & { expenseCategories?: string[] }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [f, setF] = useState({ date: todayStr(), category: '', amount: '', note: '', invoiceNumber: '' });

  function load() {
    api
      .get<PettyCashData & { expenseCategories?: string[] }>(`/finance/petty-cash?from=${from}&to=${to}`)
      .then((d) => {
        setData(d);
        setF((x) => (x.category || !d.expenseCategories?.length ? x : { ...x, category: d.expenseCategories[0]! }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the petty cash'));
  }
  useEffect(load, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount = Number(f.amount);
  const canLog = !busy && amount > 0 && !!f.category && !!f.date && f.note.trim().length >= 3;

  async function log() {
    if (!canLog) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      await api.post('/finance/expenses', { date: f.date, category: f.category, amount, note: f.note.trim(), invoiceNumber: f.invoiceNumber.trim() || undefined, method: PETTY_CASH_METHOD, paid: true });
      setDone(`Logged ${fmtKsh(amount)} for ${f.category}.`);
      setF((x) => ({ ...x, amount: '', note: '', invoiceNumber: '' }));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log the expense');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="note">{error || 'Loading…'}</p>;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 980 }}>
      <div>
        <div className="card-kicker">Finance</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 38, lineHeight: 1.05, margin: 0 }}>Petty cash</h1>
        <p className="note" style={{ marginBottom: 0 }}>See what is in the float and log what is paid out of it. Money into the float is fed by Finance.</p>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {[
          ['In the float now', data.balance],
          ['Fed in, this period', data.periodTopUpsTotal],
          ['Paid out, this period', data.periodExpensesTotal],
        ].map(([label, value]) => (
          <div key={label as string} className="card blueprint" style={{ padding: 'var(--space-3) var(--space-4)', minWidth: 200 }}>
            <div className="card-kicker">{label}</div>
            <div className="card-title">{fmtKsh(value as number)}</div>
          </div>
        ))}
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>Log a petty cash expense</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Date</label>
            <input className="input" type="date" value={f.date} max={todayStr()} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>What it was for</label>
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {(data.expenseCategories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Amount (Ksh)</label>
            <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Receipt / invoice no. (optional)</label>
            <input className="input" value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <label>Details</label>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="What was bought or paid, and to whom" />
          </div>
        </div>
        {amount > data.balance && <p className="note" style={{ color: 'var(--color-error)' }}>That is more than the {fmtKsh(data.balance)} in the float: ask Finance to feed it first.</p>}
        {error && (
          <p className="note" role="alert" style={{ color: 'var(--color-error)' }}>
            {error}
          </p>
        )}
        {done && <p className="note" role="status" style={{ fontWeight: 700 }}>{done}</p>}
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button type="button" className="btn btn-primary blueprint" disabled={!canLog} onClick={log}>
            Log expense
          </button>
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
          <div className="card-title">Petty cash ledger</div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th style={numStyle}>In</th>
                <th style={numStyle}>Out</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((r) => (
                <tr key={r.id}>
                  <td>{r.date}</td>
                  <td>{r.description}</td>
                  <td style={numStyle}>{r.amountIn > 0 ? fmtKsh(r.amountIn) : ''}</td>
                  <td style={numStyle}>{r.amountOut > 0 ? fmtKsh(r.amountOut) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.ledger.length === 0 && <p className="note">No petty cash activity in this range.</p>}
        </div>
      </div>
    </div>
  );
}
