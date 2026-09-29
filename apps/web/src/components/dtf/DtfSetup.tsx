import { useState } from 'react';
import { api } from '../../api/client';
import { Card, Corners, Field, num } from './shared';
import type { DtfTabProps } from './shared';

const FIELDS: [string, string][] = [
  ['rollLengthM', 'Roll length (m)'],
  ['rollWidthCm', 'Roll width (cm)'],
  ['stdPricePerM', 'Standard price / m'],
  ['minPricePerM', 'Minimum price / m'],
  ['defaultMultiplier', 'Default multiplier'],
  ['wastageTolerancePct', 'Wastage tolerance (%)'],
  ['unfilledWidthPremium', 'Unfilled-width premium (s)'],
  ['minBillableMetres', 'Minimum billable metres'],
  ['minPricePerPiece', 'Minimum price / piece'],
];

// wastageTolerancePct and unfilledWidthPremium can legitimately be 0 (no
// tolerance / no speed premium) — everything else must be a real positive
// number, same "every value must be greater than zero" rule as before.
const ALLOW_ZERO = new Set(['wastageTolerancePct', 'unfilledWidthPremium']);

export default function DtfSetup({ data, reload, setError }: DtfTabProps) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(data.settings).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const v = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, num(x)])) as Record<string, number>;
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
      await api.put('/dtf/settings', v);
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
      <Card title="DTF setup">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
          {FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input" inputMode="decimal" value={f[k]} onChange={(e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); }} />
            </Field>
          ))}
        </div>
        {problem && <p className="note" style={{ marginTop: 'var(--space-3)' }}>{problem}</p>}
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Sales and jobs keep every price/rate they were saved with (including the billable-metres figure the
          unfilled-width premium resolved to), so changing these only affects new records. A roll's length is fixed
          when it's installed. The 5% wastage tolerance is a starting assumption — set your own target. The
          unfilled-width premium bills a part-width artwork job extra for tying up the whole roll length before the
          row fills — 0 disables it entirely; 0.5 means up to +50% at zero fill.
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
