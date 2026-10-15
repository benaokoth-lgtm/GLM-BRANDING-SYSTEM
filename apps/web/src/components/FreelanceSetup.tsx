import { useEffect, useState } from 'react';
import { DEFAULT_FREELANCE_BANDS, DEFAULT_FREELANCE_LOW_MARGIN_PCT, DEFAULT_FREELANCE_PREMIUM_PCT, DEFAULT_FREELANCE_WHT_RATE, bandsProblem } from '@glm/shared';
import type { Band } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Card, Loading, Notice, useLoad } from '../pages/accounting/shared';
import BandEditor from './BandEditor';
import BigSaleScenario from './BigSaleScenario';

// Commission → Freelancers → Rates: the set-up of freelance commission, on its own. An Admin changes any of it at any time. A change applies from the moment it is saved: a week is worked out with
// the rates in force when it is approved, so a week already approved keeps its amount until it is approved again, and a paid week never changes. Managers see the rates but cannot change them. These
// are the same fields as the freelance part of Commission → Rates, so changing them in either place changes both; "How it works" is written from them.

interface Settings {
  freelanceBands: Band[];
  freelanceOwnershipMonths: number;
  freelanceWhtRate: number;
  freelancePremiumPct: number;
  freelanceLowMarginPct: number;
}

const toBands = (rows: { from: string; rate: string }[]): Band[] => rows.map((r) => ({ from: Number(r.from) || 0, rate: Number(r.rate) || 0 }));
const toRows = (bands: Band[]) => bands.map((b) => ({ from: String(b.from), rate: String(b.rate) }));

export default function FreelanceSetup() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const { data, error, loading, reload } = useLoad<Settings>('/commission/settings');
  const [bands, setBands] = useState<{ from: string; rate: string }[]>([]);
  const [premium, setPremium] = useState('');
  const [low, setLow] = useState('');
  const [months, setMonths] = useState('');
  const [wht, setWht] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const fill = (d: Settings) => {
    setBands(toRows(d.freelanceBands));
    setPremium(String(d.freelancePremiumPct));
    setLow(String(d.freelanceLowMarginPct));
    setMonths(String(d.freelanceOwnershipMonths));
    setWht(String(d.freelanceWhtRate));
  };
  useEffect(() => {
    if (data) fill(data);
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const inRange = (v: string, lo: number, hi: number) => v.trim() !== '' && Number(v) >= lo && Number(v) <= hi;
  const problem =
    bandsProblem(toBands(bands), 'Freelance bands') ??
    (!inRange(premium, 0, 100) ? 'The share of what is charged above base must be from 0 to 100' : !inRange(low, 0, 100) ? 'The weight of thin-margin lines must be from 0 to 100' : !inRange(wht, 0, 100) ? 'The withholding tax must be from 0 to 100' : !(Number.isInteger(Number(months)) && Number(months) >= 1 && Number(months) <= 60) ? 'The months a client stays theirs must be a whole number from 1 to 60' : null);
  const changed =
    JSON.stringify(toBands(bands)) !== JSON.stringify(data.freelanceBands) || Number(premium) !== data.freelancePremiumPct || Number(low) !== data.freelanceLowMarginPct || Number(months) !== data.freelanceOwnershipMonths || Number(wht) !== data.freelanceWhtRate;

  async function save() {
    setBusy(true);
    setSaveError('');
    setMessage('');
    try {
      await api.put('/commission/freelance-settings', {
        freelanceBands: toBands(bands),
        freelancePremiumPct: Number(premium),
        freelanceLowMarginPct: Number(low),
        freelanceOwnershipMonths: Number(months),
        freelanceWhtRate: Number(wht),
      });
      setMessage('Saved. The new rates apply from now on.');
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Freelance commission — rates and set-up" hint={isAdmin ? 'Change any of these whenever you need to. A change applies from the moment it is saved: a week is worked out with the rates in force when it is approved. A week already approved keeps its amount until it is approved again; a paid week never changes.' : 'Only an Admin can change these rates. You can see what freelance sales persons are paid under.'}>
      <Notice error={saveError || undefined} message={message || undefined} />
      <fieldset disabled={!isAdmin || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-4)', minWidth: 0 }}>
        <BandEditor
          title="The base part — weekly bands"
          hint="Marginal bands on the BASE-price part of a freelance sales person’s WEEKLY net sales received (Monday to Sunday), on orders credited to them, counting only lines sold at or above our base prices. Each rate applies only to the slice of the week inside its band. Keep these rates well inside the margin you make at base price."
          unit="Ksh net per week"
          bands={bands}
          onChange={setBands}
        />
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>The premium: % of what is charged above base that they keep</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={premium} onChange={(e) => setPremium(e.target.value)} aria-label="Share of the premium" />
            <p className="note" style={{ margin: 0 }}>Selling the same job for more costs us nothing extra, so this is nearly all profit. The company keeps the rest.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Contracted-out and stock lines count at this % towards the bands</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} aria-label="Weight of thin-margin lines" />
            <p className="note" style={{ margin: 0 }}>These carry a thin mark-up. 50 = their base part counts half; 100 = no reduction. Any amount above base is still shared in full.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>A client stays theirs while an order comes at least every (months)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} aria-label="Months a client stays theirs" />
            <p className="note" style={{ margin: 0 }}>Every order they bring restarts the count. It applies to all their clients at once, counted from each client’s last order.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Withholding tax deducted from their pay (%)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={wht} onChange={(e) => setWht(e.target.value)} aria-label="Withholding tax rate" />
            <p className="note" style={{ margin: 0 }}>The standard rate; a person can have their own rate under Freelance sales persons &amp; accounts (0 = exempt). Confirm the rate with your accountant.</p>
          </div>
        </div>
        <BigSaleScenario bands={toBands(bands)} whtRate={Number(wht) || 0} />
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
                setBands(toRows(DEFAULT_FREELANCE_BANDS));
                setPremium(String(DEFAULT_FREELANCE_PREMIUM_PCT));
                setLow(String(DEFAULT_FREELANCE_LOW_MARGIN_PCT));
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
