import { useEffect, useState } from 'react';
import { DEFAULT_FREELANCE_LOW_RATE_PCT, DEFAULT_FREELANCE_RATE_PCT, DEFAULT_FREELANCE_WHT_RATE, fmtKsh, freelanceCommission, withholdingOn } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Card, Loading, Notice, numStyle, useLoad } from '../pages/accounting/shared';

// Commission → Freelancers → Rates: where an Admin sets the freelance commission, and changes it from time to time. The scheme is two flat percentages of net sales received (VAT out): the standard
// rate, and a lower rate on thin-margin lines. A change applies from the moment it is saved: a week is worked out at the rates in force when it is approved, so an approved or paid week keeps its
// amount. Managers see the rates but cannot change them. Every change is recorded in the audit trail (Master Data → Security).

interface Settings {
  freelanceRatePct: number;
  freelanceLowRatePct: number;
  freelanceOwnershipMonths: number;
  freelanceWhtRate: number;
}

const MONTHLY = [100_000, 300_000, 500_000, 1_000_000];

export default function FreelanceSetup() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const { data, error, loading, reload } = useLoad<Settings>('/commission/settings');
  const [rate, setRate] = useState('');
  const [low, setLow] = useState('');
  const [months, setMonths] = useState('');
  const [wht, setWht] = useState('');
  const [margin, setMargin] = useState('50'); // for the illustration only
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const fill = (d: Settings) => {
    setRate(String(d.freelanceRatePct));
    setLow(String(d.freelanceLowRatePct));
    setMonths(String(d.freelanceOwnershipMonths));
    setWht(String(d.freelanceWhtRate));
  };
  useEffect(() => {
    if (data) fill(data);
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const inRange = (v: string, lo: number, hi: number) => v.trim() !== '' && Number(v) >= lo && Number(v) <= hi;
  const problem = !inRange(rate, 0, 30)
    ? 'The commission rate must be from 0 to 30%'
    : !inRange(low, 0, 30)
      ? 'The rate on thin-margin lines must be from 0 to 30%'
      : Number(low) > Number(rate)
        ? 'The rate on thin-margin lines cannot be more than the standard rate'
        : !(Number(months) >= 1 && Number(months) <= 60)
          ? 'The months a client stays theirs must be from 1 to 60'
          : !inRange(wht, 0, 100)
            ? 'The withholding tax must be from 0 to 100%'
            : '';
  const changed = Number(rate) !== data.freelanceRatePct || Number(low) !== data.freelanceLowRatePct || Number(months) !== data.freelanceOwnershipMonths || Number(wht) !== data.freelanceWhtRate;

  async function save() {
    setBusy(true);
    setSaveError('');
    setMessage('');
    try {
      await api.put('/commission/freelance-settings', { freelanceRatePct: Number(rate), freelanceLowRatePct: Number(low), freelanceOwnershipMonths: Number(months), freelanceWhtRate: Number(wht) });
      setMessage('Saved. The new rates apply to every week not yet approved, from now on.');
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }

  // an illustration, at the rates typed (not yet saved): all sales at the standard rate
  const r = Number(rate) || 0;
  const l = Number(low) || 0;
  const w = Number(wht) || 0;
  const gm = Number(margin) || 0;

  return (
    <Card title="Freelance commission — rates and set-up" hint={isAdmin ? 'Change these whenever you need to. A change applies from the moment it is saved: a week is worked out at the rates in force when it is approved, so an approved or paid week keeps its amount.' : 'These are the rates in force. Only an Admin can change them.'}>
      <Notice error={saveError || undefined} message={message || undefined} />
      <fieldset disabled={!isAdmin || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-4)', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Commission: % of net sales received (VAT out)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Commission rate" />
            <p className="note" style={{ margin: 0 }}>The freelancer’s share of what the client actually pays, before VAT. Suggested: {DEFAULT_FREELANCE_RATE_PCT}.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Lower rate on thin-margin lines (%)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} aria-label="Rate on thin-margin lines" />
            <p className="note" style={{ margin: 0 }}>For contracted-out services and stock resale, which carry a thin mark-up. Suggested: {DEFAULT_FREELANCE_LOW_RATE_PCT}.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>A client stays theirs while an order comes at least every (months)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} aria-label="Months a client stays theirs" />
            <p className="note" style={{ margin: 0 }}>Every order they bring restarts the count.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Withholding tax deducted from their pay (%)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={wht} onChange={(e) => setWht(e.target.value)} aria-label="Withholding tax rate" />
            <p className="note" style={{ margin: 0 }}>The standard rate; a person can have their own (0 = exempt). Confirm the rate with your accountant.</p>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
            <div className="card-title" style={{ fontSize: 15 }}>What it pays, at these rates</div>
            <div className="field" style={{ margin: 0 }}>
              <label>Company gross margin (%)</label>
              <input className="input" style={{ maxWidth: 90 }} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} aria-label="Company gross margin" />
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={numStyle}>Net sales brought in a month</th>
                  <th style={numStyle}>Commission</th>
                  <th style={numStyle}>After {w}% tax</th>
                  <th style={numStyle}>Company keeps of gross profit</th>
                  <th style={numStyle}>Share of gross profit paid out</th>
                </tr>
              </thead>
              <tbody>
                {MONTHLY.map((net) => {
                  const c = freelanceCommission(net, 0, r, l).total;
                  const gross = (net * gm) / 100;
                  return (
                    <tr key={net}>
                      <td style={numStyle}>{fmtKsh(net)}</td>
                      <td style={numStyle}>{fmtKsh(c)}</td>
                      <td style={numStyle}>{fmtKsh(c - withholdingOn(c, w))}</td>
                      <td style={numStyle}>{fmtKsh(gross - c)}</td>
                      <td style={numStyle}>{gross > 0 ? `${Math.round((c / gross) * 1000) / 10}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note" style={{ margin: 0 }}>Everything at the standard rate; thin-margin lines earn the lower rate. The company still has its overheads to cover and corporate tax to pay out of what is kept, so keep the rate where the profit after overheads stays healthy.</p>
        </div>

        {problem && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{problem}</p>}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!problem || !changed} onClick={save}>
              Save the freelance rates
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !changed} onClick={() => { fill(data); setMessage(''); setSaveError(''); }}>
              Discard changes
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              title="Fill in the suggested starting rates (nothing changes until you save)"
              onClick={() => {
                setRate(String(DEFAULT_FREELANCE_RATE_PCT));
                setLow(String(DEFAULT_FREELANCE_LOW_RATE_PCT));
                setWht(String(DEFAULT_FREELANCE_WHT_RATE));
                setMonths('12');
              }}
            >
              Use the suggested starting rates
            </button>
          </div>
        )}
      </fieldset>
    </Card>
  );
}
