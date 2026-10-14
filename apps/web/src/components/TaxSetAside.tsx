import { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';

// Compliance → Corporation tax → Tax set-aside planner, and the one-line version on Accounting → Profit & Loss. For information and planning: how much of the profit to put aside for
// the year's income tax, month by month, and how much has been. Nothing here is posted to the books. The amount to hold by the end of a month is the tax on the year's profit SO FAR,
// so a loss month brings it down instead of going negative.

export interface SetAside {
  year: number;
  period: { start: string; end: string };
  regime: 'corporation' | 'turnover';
  rate: number;
  asOf: string;
  months: { month: string; future: boolean; profit: number; addBacks: number; sales: number; requiredToDate: number; planThisMonth: number; setAside: number; setAsideToDate: number; shortfall: number }[];
  ytd: { profit: number; requiredToDate: number; setAside: number; shortfall: number; paidToKra: number; held: number };
  moveNow: number;
  projection: { tax: number; perMonthFromNow: number };
  dueSoon: { amount: number; covered: boolean; instalments: { key: string; label: string; dueDate: string; outstanding: number }[] };
  entries: { id: number; date: string; amount: number; note: string; capturedByName: string }[];
}

const R = { textAlign: 'right' } as const;
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' });

/** One line for the Profit & Loss: what to put aside now for the income tax. Quiet when the person has no Finance access. */
export function SetAsideBanner() {
  const [d, setD] = useState<SetAside | null>(null);
  useEffect(() => {
    api.get<SetAside>('/tax/set-aside/current').then(setD).catch(() => setD(null));
  }, []);
  if (!d) return null;
  return (
    <p className="note" style={{ margin: 0, borderLeft: '3px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
      <b>Income tax set-aside ({d.rate}%):</b> to hold by now {fmtKsh(d.ytd.requiredToDate)} · set aside so far {fmtKsh(d.ytd.setAside)} ·{' '}
      {d.moveNow > 0 ? <b>put aside {fmtKsh(d.moveNow)} now to be on track</b> : 'on track'}. See Compliance → Corporation tax. (Planning only; nothing is posted to the books.)
    </p>
  );
}

export default function TaxSetAside({ year }: { year: number }) {
  const [d, setD] = useState<SetAside | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ date: todayStr(), amount: '', note: '' });

  const load = useCallback(() => {
    setErr('');
    api
      .get<SetAside>(`/tax/year/${year}/set-aside`)
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the planner'));
  }, [year]);
  useEffect(() => {
    setD(null);
    load();
  }, [load]);

  async function add() {
    const amount = Number(form.amount);
    if (!(amount > 0)) return setErr('Enter the amount you moved');
    setBusy(true);
    setErr('');
    try {
      setD(await api.post<SetAside>(`/tax/year/${year}/set-aside`, { date: form.date, amount, note: form.note }));
      setForm((f) => ({ ...f, amount: '', note: '' }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record it');
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    if (!window.confirm('Remove this entry from the set-aside record?')) return;
    setBusy(true);
    try {
      setD(await api.del<SetAside>(`/tax/set-aside/${id}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove it');
    } finally {
      setBusy(false);
    }
  }

  if (!d) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading the planner…</p>;
  const turnover = d.regime === 'turnover';
  const behind = d.ytd.shortfall > 0.5;
  return (
    <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Tax set-aside planner · {d.year} · information and planning only</div>
      <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, lineHeight: 1.1 }}>{d.moveNow > 0 ? fmtKsh(d.moveNow) : 'On track'}</div>
          <div className="note" style={{ margin: 0 }}>
            {d.moveNow > 0 ? 'to put aside now, to hold the tax on the year’s profit so far.' : `You have set aside what the tax on the year’s profit so far needs${d.ytd.shortfall < -0.5 ? ` (${fmtKsh(-d.ytd.shortfall)} ahead)` : ''}.`}
          </div>
        </div>
        <div className="note" style={{ margin: 0, maxWidth: 460 }}>
          {turnover ? `${d.rate}% of the month’s sales` : `${d.rate}% of the year’s profit so far`}, taken from the books ({fmtKsh(d.ytd.profit)} profit so far, with the add-backs the tax working makes). Projected tax for the year: <b>{fmtKsh(d.projection.tax)}</b>
          {d.projection.perMonthFromNow > 0 ? <>, about <b>{fmtKsh(d.projection.perMonthFromNow)}</b> a month more for the rest of the year</> : ''}.
        </div>
      </div>

      {d.dueSoon.amount > 0 && (
        <p className="note" style={{ borderLeft: `3px solid ${d.dueSoon.covered ? 'var(--color-accent)' : 'var(--color-error)'}`, paddingLeft: 'var(--space-2)' }}>
          Due to KRA now or within 60 days (past-due ones included): <b>{fmtKsh(d.dueSoon.amount)}</b> ({d.dueSoon.instalments.map((i) => `${i.label}, ${fmtDate(i.dueDate)}`).join('; ')}).{' '}
          {d.dueSoon.covered ? `The ${fmtKsh(d.ytd.held)} you hold covers it.` : `You hold ${fmtKsh(Math.max(0, d.ytd.held))} — ${fmtKsh(d.dueSoon.amount - d.ytd.held)} short.`}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', margin: 'var(--space-3) 0' }}>
        {[
          ['To hold by now', d.ytd.requiredToDate],
          ['Set aside so far', d.ytd.setAside],
          [behind ? 'Short' : 'Ahead', Math.abs(d.ytd.shortfall)],
          ['Paid to KRA so far', d.ytd.paidToKra],
          ['Held after those payments', d.ytd.held],
        ].map(([label, value]) => (
          <div key={label as string} style={{ minWidth: 150 }}>
            <div className="card-kicker">{label}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, color: label === 'Short' ? 'var(--color-error)' : undefined }}>{fmtKsh(value as number)}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Month</th>
              <th style={R}>Profit</th>
              <th style={R}>To hold by month-end</th>
              <th style={R}>Plan for the month</th>
              <th style={R}>Set aside</th>
              <th style={R}>Set aside to date</th>
              <th style={R}>Short / ahead</th>
            </tr>
          </thead>
          <tbody>
            {d.months.map((m) => (
              <tr key={m.month} style={m.future ? { opacity: 0.45 } : undefined}>
                <td>{monthLabel(m.month)}</td>
                <td style={R}>{m.future ? '' : fmtKsh(m.profit)}</td>
                <td style={R}>{m.future ? '' : fmtKsh(m.requiredToDate)}</td>
                <td style={R}>{m.future ? '' : fmtKsh(m.planThisMonth)}</td>
                <td style={R}>{m.setAside > 0 ? fmtKsh(m.setAside) : ''}</td>
                <td style={R}>{m.future ? '' : fmtKsh(m.setAsideToDate)}</td>
                <td style={{ ...R, color: m.shortfall > 0.5 ? 'var(--color-error)' : undefined }}>{m.future ? '' : m.shortfall > 0.5 ? `short ${fmtKsh(m.shortfall)}` : m.shortfall < -0.5 ? `ahead ${fmtKsh(-m.shortfall)}` : 'on track'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Moved into the tax savings on</label>
          <input className="input" type="date" value={form.date} max={todayStr()} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, width: 160 }}>
          <label>Amount (Ksh)</label>
          <input className="input" inputMode="decimal" value={form.amount} placeholder={d.moveNow > 0 ? String(Math.round(d.moveNow)) : ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, flex: '1 1 200px' }}>
          <label>Note (optional)</label>
          <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. to the tax savings account" />
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !(Number(form.amount) > 0)} onClick={add}>
          Record
        </button>
        {d.moveNow > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, amount: String(Math.round(d.moveNow)) })}>
            Use {fmtKsh(d.moveNow)}
          </button>
        )}
      </div>
      {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}
      {d.entries.length > 0 && (
        <table className="table" style={{ marginTop: 'var(--space-2)', maxWidth: 720 }}>
          <tbody>
            {d.entries.map((e) => (
              <tr key={e.id}>
                <td>{fmtDate(e.date)}</td>
                <td style={R}>{fmtKsh(e.amount)}</td>
                <td className="text-muted">{e.note}{e.note ? ' · ' : ''}{e.capturedByName}</td>
                <td>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(e.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="note" style={{ marginBottom: 0 }}>
        Record what you actually move into the tax savings (a separate bank or M-Pesa account is best) so the planner can show whether you are on track. The amount to hold is the tax on the year’s profit so far at the rate set above, so a loss month
        lowers it. It is a plan: the real tax is worked out below from the whole year, and payments to KRA are recorded further down; recording a set-aside moves no money and posts nothing to the books.
      </p>
    </div>
  );
}
