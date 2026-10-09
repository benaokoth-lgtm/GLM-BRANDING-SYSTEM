import { useEffect, useState } from 'react';
import { quoteDesign } from '@glm/shared';
import type { EmbroiderySettingsValues } from '@glm/shared';
import { api } from '../api/client';
import { fmtKsh } from '@glm/shared';
import { Card, Loading, Notice, useLoad } from '../pages/accounting/shared';

// Master Data → Embroidery Pricing (Admin): the numbers behind the Embroidery Order calculator. Each order keeps a copy of what it was priced with, so changing
// them never reprices an order already taken.

interface Config {
  settings: EmbroiderySettingsValues;
}
interface Row {
  min: string;
  rate: string;
  floor: string;
}

const n = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);

export default function EmbroiderySettingsPanel() {
  const { data, error, loading, reload } = useLoad<Config>('/embroidery/config');
  const [fees, setFees] = useState({ setupFee: '', originationFee: '', waiveAtQty: '' });
  const [tiers, setTiers] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [sample, setSample] = useState({ stitches: '6000', qty: '12' });

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setFees({ setupFee: String(s.setupFee), originationFee: String(s.originationFee), waiveAtQty: String(s.waiveAtQty) });
    setTiers(s.tiers.map((t) => ({ min: String(t.min), rate: String(t.rate), floor: String(t.floor) })));
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;

  const current: EmbroiderySettingsValues = { setupFee: n(fees.setupFee), originationFee: n(fees.originationFee), waiveAtQty: Math.round(n(fees.waiveAtQty)), tiers: tiers.map((t) => ({ min: n(t.min), rate: n(t.rate), floor: n(t.floor) })) };
  const preview = quoteDesign({ name: 'sample', stitches: Math.round(n(sample.stitches)) }, Math.max(1, Math.round(n(sample.qty))), current);

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.put('/embroidery/settings', current);
      setMsg('Saved. New orders use these numbers; orders already taken keep the numbers they were priced with.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const setTier = (i: number, patch: Partial<Row>) => setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 'var(--space-4)', alignItems: 'start' }}>
      <Card title="Embroidery pricing" hint="Per piece = the stitch rate × stitches ÷ 1,000, but never less than the minimum for that quantity, rounded up to the whole shilling. The setup (digitizing) fee and the design origination fee are their own lines on the order.">
        <Notice error={err} message={msg} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="field">
            <label>Digitizing setup (KES, per design)</label>
            <input className="input" inputMode="numeric" value={fees.setupFee} onChange={(e) => setFees((f) => ({ ...f, setupFee: e.target.value }))} />
          </div>
          <div className="field">
            <label>Design origination (KES, per job)</label>
            <input className="input" inputMode="numeric" value={fees.originationFee} onChange={(e) => setFees((f) => ({ ...f, originationFee: e.target.value }))} />
          </div>
          <div className="field">
            <label>Waive setup from (pieces)</label>
            <input className="input" inputMode="numeric" value={fees.waiveAtQty} onChange={(e) => setFees((f) => ({ ...f, waiveAtQty: e.target.value }))} />
          </div>
        </div>
        <p className="note">Setup is usually KES 1,000–1,500 by complexity. A 0 in “waive setup from” means never. Design origination applies only when the client does not bring their own artwork.</p>

        <div className="card-kicker" style={{ marginTop: 'var(--space-3)' }}>Stitch-rate tiers</div>
        <table className="table">
          <thead>
            <tr>
              <th>From pieces</th>
              <th>KES / 1,000 stitches</th>
              <th>Minimum per piece</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td>
                  <input className="input" inputMode="numeric" value={t.min} onChange={(e) => setTier(i, { min: e.target.value })} />
                </td>
                <td>
                  <input className="input" inputMode="decimal" value={t.rate} onChange={(e) => setTier(i, { rate: e.target.value })} />
                </td>
                <td>
                  <input className="input" inputMode="numeric" value={t.floor} onChange={(e) => setTier(i, { floor: e.target.value })} />
                </td>
                <td>
                  {tiers.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this tier" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={tiers.length >= 12} onClick={() => setTiers((ts) => [...ts, { min: '', rate: '', floor: '' }])}>
            + Add a tier
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
        <p className="note">The first tier must start at 1 piece. Set the same minimum on every tier for one flat minimum price per piece.</p>
      </Card>

      <Card title="Try it" hint="What the numbers above give for one design, before you save.">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="field">
            <label>Stitches</label>
            <input className="input" inputMode="numeric" value={sample.stitches} onChange={(e) => setSample((s) => ({ ...s, stitches: e.target.value }))} />
          </div>
          <div className="field">
            <label>Pieces</label>
            <input className="input" inputMode="numeric" value={sample.qty} onChange={(e) => setSample((s) => ({ ...s, qty: e.target.value }))} />
          </div>
        </div>
        <table className="table">
          <tbody>
            <tr><td>Stitch rate</td><td style={{ textAlign: 'right' }}>{preview.rate} / 1,000</td></tr>
            <tr><td>Stitch cost per piece</td><td style={{ textAlign: 'right' }}>{fmtKsh(preview.stitchCost)}</td></tr>
            <tr><td>{preview.floored ? 'Minimum applied' : 'Minimum (not triggered)'}</td><td style={{ textAlign: 'right' }}>{fmtKsh(preview.floor)}</td></tr>
            <tr><td><b>Price per piece</b></td><td style={{ textAlign: 'right' }}><b>{fmtKsh(preview.recommended)}</b></td></tr>
            <tr><td>Pieces</td><td style={{ textAlign: 'right' }}>{fmtKsh(preview.pieces)}</td></tr>
            <tr><td>Setup (own line)</td><td style={{ textAlign: 'right' }}>{preview.setupWaived ? 'Waived' : fmtKsh(preview.setup)}</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
