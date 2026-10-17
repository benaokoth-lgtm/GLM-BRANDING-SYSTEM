import { useState } from 'react';
import { fmtKsh, runningMetreCalc } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Corners, Field, num } from './shared';
import type { DtfTabProps } from './shared';
import type { PriceList } from '@glm/shared';
import ListSwitch from './ListSwitch';
import DtfFreelancerSetup from './DtfFreelancerSetup';

const FIELDS: [string, string][] = [
  ['rollLengthM', 'Roll length (m)'],
  ['rollWidthCm', 'Roll width (cm)'],
  ['stdPricePerM', 'Standard price / m (film sales — staff may charge more)'],
  ['minPricePerM', 'Minimum price / m (film sales — the base commission is paid above)'],
  ['wastageTolerancePct', 'Wastage tolerance (%)'],
  ['fixedChargePerMetre', 'Charge per running metre (artwork jobs)'],
  ['minPricePerPiece', 'Lowest price / artwork (0 for none)'],
  ['smallShareBelow', 'Small share: an artwork\'s share of the film below (0 for none)'],
  ['smallSharePrice', 'Small share: the recommended price is then'],
];

// wastageTolerancePct can legitimately be 0 (no tolerance), and so can the lowest price of an artwork (none) — everything else
// must be a real positive number.
const ALLOW_ZERO = new Set(['wastageTolerancePct', 'minPricePerPiece', 'smallShareBelow', 'smallSharePrice']);

export default function DtfSetup(props: DtfTabProps) {
  // GLM Sales rates (the saved setup) or the Freelancer Sales rates
  const [list, setList] = useState<PriceList>('glm');
  return (
    <>
      <ListSwitch value={list} onChange={setList} />
      {list === 'freelancer' ? <DtfFreelancerSetup {...props} /> : <GlmSetup {...props} />}
    </>
  );
}

function GlmSetup({ data, reload, setError }: DtfTabProps) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(data.settings).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const v = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, num(x)])) as Record<string, number>;
  // the worked example under the fields, from what is typed: 0.53 m of film carrying 2 artworks
  const eg = runningMetreCalc(0.53, 2, v.fixedChargePerMetre || 0, v.smallShareBelow || 0, v.smallSharePrice || 0);
  const example = v.fixedChargePerMetre > 0 ? `For example, 0.53 m with 2 artworks on it: ${fmtKsh(v.fixedChargePerMetre)} × 0.53 m = ${fmtKsh(Math.round(v.fixedChargePerMetre * 0.53 * 100) / 100)}, shared by 2 = ${fmtKsh(eg.finalPerPiece)} each (${fmtKsh(eg.jobTotal)} in all).` : '';
  const problem =
    FIELDS.some(([k]) => (ALLOW_ZERO.has(k) ? v[k] < 0 : !(v[k] > 0)))
      ? 'Every value must be greater than zero.'
      : v.minPricePerM > v.stdPricePerM
        ? 'Minimum price cannot be above the standard price.'
        : v.minPricePerPiece > 0 && v.smallSharePrice > 0 && v.smallSharePrice < v.minPricePerPiece
          ? 'The price used for a small share cannot be below the lowest price of an artwork.'
          : v.smallShareBelow > 0 && v.smallSharePrice > 0 && v.smallSharePrice < v.smallShareBelow
            ? 'The price used for a small share cannot be below the share it applies to.'
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
          is shared equally between the artworks on that length, so the client bears the empty space. Price per artwork = (charge per metre × running metres) ÷ artworks — nothing else is added.
          {v.minPricePerPiece > 0 ? ` The lowest price of an artwork is the least anyone may charge for one.` : ''}{v.smallShareBelow > 0 && v.smallSharePrice > 0 ? ` When an artwork's share of the film comes to less than ${fmtKsh(v.smallShareBelow)}, its recommended price is ${fmtKsh(v.smallSharePrice)} instead.` : ''} {example}
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
