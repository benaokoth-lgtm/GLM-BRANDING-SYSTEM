import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import type { DtfSettings } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Corners, Field, num } from './shared';
import type { DtfTabProps } from './shared';

// DTF → Setup, switched to Freelancer Sales: the money rates a Freelancer Sales order works from. Each is the GLM rate less the default percentage (Master Data → Freelancer Prices), rounded — unless a
// rate has been typed by hand here, which wins and stays when the GLM rate changes. Roll size, width and wastage are the same for both lists, so they are set once, on the GLM side.

const FIELDS: [keyof Pick<DtfSettings, 'stdPricePerM' | 'minPricePerM' | 'fixedChargePerMetre' | 'minPricePerPiece' | 'smallShareBelow' | 'smallSharePrice'>, string][] = [
  ['stdPricePerM', 'Standard price / m (film sales)'],
  ['minPricePerM', 'Minimum price / m (film sales — the base for the premium)'],
  ['fixedChargePerMetre', 'Charge per running metre (artwork jobs)'],
  ['minPricePerPiece', 'Lowest price / artwork (0 for none)'],
  ['smallShareBelow', 'Small share: an artwork’s share of the film below (0 for none)'],
  ['smallSharePrice', 'Small share: the recommended price is then'],
];

interface FlData {
  settings: DtfSettings;
  freelancerManual: Record<string, boolean>;
  freelancerDiscountPct: number;
  glmSettings: Record<string, number>;
}

export default function DtfFreelancerSetup({ data, setError }: DtfTabProps) {
  const [fl, setFl] = useState<FlData | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () =>
    api
      .get<FlData>(`/dtf/data?product=${data.product}&scope=order&priceList=freelancer`)
      .then((d) => {
        setFl(d);
        setF(Object.fromEntries(FIELDS.map(([k]) => [k, String(d.settings[k])])));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the Freelancer rates'));
  useEffect(() => {
    void load();
  }, [data.product]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!fl) return <p className="note">Loading…</p>;

  async function save() {
    if (!fl) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // a rate already typed by hand, or one the person has changed, is set by hand; one left as it was follows the percentage
      const body = Object.fromEntries(FIELDS.map(([k]) => [k, fl.freelancerManual[k] || num(f[k] ?? '') !== fl.settings[k] ? num(f[k] ?? '') : null]));
      await api.put(`/dtf/settings?priceList=freelancer&product=${data.product}`, body);
      await load();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }
  async function followAgain() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/dtf/settings?priceList=freelancer&product=${data.product}`, Object.fromEntries(FIELDS.map(([k]) => [k, null])));
      await load();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }
  const anyTyped = Object.values(fl.freelancerManual).some(Boolean);

  return (
    <div style={{ maxWidth: 760 }}>
      <Card title={`${data.product === 'uv' ? 'UV DTF' : 'DTF'} setup — Freelancer Sales`}>
        <p className="note" style={{ marginTop: 0 }}>
          Each rate below is the GLM rate less <b>{fl.freelancerDiscountPct}%</b>, rounded — shown next to the GLM rate. Type a different figure for any of them and it is kept as typed (and does not move when the GLM rate does).
          Changes apply to new orders from the moment you save.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
          {FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input" inputMode="decimal" value={f[k] ?? ''} onChange={(e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); }} />
              <span className="note" style={{ margin: 0, fontSize: 12 }}>
                GLM {fmtKsh(fl.glmSettings[k] ?? 0)} · {fl.freelancerManual[k] ? <b>typed by hand</b> : 'follows the percentage'}
              </span>
            </Field>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary blueprint" disabled={busy} onClick={save}>
            <Corners />
            Save Freelancer rates
          </button>
          {anyTyped && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={followAgain}>
              Follow the percentage again for all
            </button>
          )}
          {saved && <span className="note">Saved.</span>}
        </div>
      </Card>
    </div>
  );
}
