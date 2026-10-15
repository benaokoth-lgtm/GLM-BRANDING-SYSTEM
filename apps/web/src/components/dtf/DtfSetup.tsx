import { useState } from 'react';
import { fmtKsh, fmtNum, jobCalc } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Corners, Field, num } from './shared';
import type { DtfTabProps } from './shared';

const FIELDS: [string, string][] = [
  ['rollLengthM', 'Roll length (m)'],
  ['rollWidthCm', 'Roll width (cm)'],
  ['stdPricePerM', 'Standard price / m (film sales — staff may charge more)'],
  ['minPricePerM', 'Minimum price / m (film sales — the base commission is paid above)'],
  ['wastageTolerancePct', 'Wastage tolerance (%)'],
  ['fixedChargePerMetre', 'Charge per running metre (artwork jobs)'],
  ['minPricePerPiece', 'Minimum price / piece (artwork jobs — 0 for none)'],
];

// wastageTolerancePct can legitimately be 0 (no tolerance), and so can the per-piece minimum (the price is then just the artwork's share of the running metres) — everything else
// must be a real positive number.
const ALLOW_ZERO = new Set(['wastageTolerancePct', 'minPricePerPiece']);

export default function DtfSetup({ data, reload, setError }: DtfTabProps) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(data.settings).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const v = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, num(x)])) as Record<string, number>;
  // the worked example under the fields, from what is typed: 0.53 m of film carrying 2 artworks
  const eg = jobCalc(0.53, 2, v.fixedChargePerMetre || 0, v.minPricePerPiece || 0);
  const example = v.fixedChargePerMetre > 0 ? `For example, 0.53 m with 2 artworks on it: ${fmtKsh(v.fixedChargePerMetre)} × 0.53 m = ${fmtKsh(Math.round(v.fixedChargePerMetre * 0.53 * 100) / 100)}${v.minPricePerPiece > 0 ? ` + ${fmtKsh(v.minPricePerPiece)} × 2` : ''}, shared by 2 = ${fmtKsh(eg.finalPerPiece)} each (${fmtKsh(eg.jobTotal)} in all).` : '';
  const problem =
    FIELDS.some(([k]) => (ALLOW_ZERO.has(k) ? v[k] < 0 : !(v[k] > 0)))
      ? 'Every value must be greater than zero.'
      : v.minPricePerM > v.stdPricePerM
        ? 'Minimum price cannot be above the standard price.'
        : '';

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put(`/dtf/settings?product=${data.product}`, v);
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save setup');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <Card title={`${data.product === 'uv' ? 'UV DTF' : 'DTF'} setup`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
          {FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input" inputMode="decimal" value={f[k]} onChange={(e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); }} />
            </Field>
          ))}
        </div>
        {problem && <p className="note" style={{ marginTop: 'var(--space-3)' }}>{problem}</p>}
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Sales and jobs keep every price/rate they were saved with, so changing these only affects new records. A
          roll's length is fixed when it's installed. The 5% wastage tolerance is a starting assumption — set your
          own target.
        </p>
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <b>How an artwork job is charged.</b> The film is charged by the <b>running metres</b> it uses, whether or not the artwork fills the width: the charge per running metre × the running metres
          is shared equally between the artworks on that length, so the client bears the empty space. Price per artwork = (charge per metre × running metres) ÷ artworks
          {v.minPricePerPiece > 0 ? ', and no artwork is charged less than the minimum per piece, which is added to each artwork' : ''}. {example}
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-3)' }}>
          <button type="button" className="btn btn-primary blueprint" disabled={busy || !!problem} onClick={save}>
            <Corners />
            Save setup
          </button>
          {saved && <span className="note">Saved.</span>}
        </div>
      </Card>
    </div>
  );
}
