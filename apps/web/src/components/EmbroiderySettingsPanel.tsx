import { useEffect, useState } from 'react';
import { fmtKsh, quantityPrice, sortedQtyTiers, stitchPrice } from '@glm/shared';
import type { EmbroiderySettingsValues } from '@glm/shared';
import { api } from '../api/client';
import { Card, Loading, Notice, useLoad } from '../pages/accounting/shared';

// Master Data → Embroidery Pricing (Admin): the numbers behind the Embroidery Order calculator. The price is set by STITCH COUNT first (a rate per 1,000 stitches); the
// price by QUANTITY is that price less a discount that grows with the quantity, so it is lower and never higher. The staff apply either on an order. Each order keeps a
// copy of what it was priced with, so changing these never reprices an order already taken.

interface Config {
  settings: EmbroiderySettingsValues;
}
interface Row {
  min: string;
  discountPct: string;
}

const n = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;
const SAMPLE_STITCHES = [3000, 5000, 6000, 8000, 10000, 12000, 15000, 20000];

export default function EmbroiderySettingsPanel() {
  const { data, error, loading, reload } = useLoad<Config>('/embroidery/config');
  const [fees, setFees] = useState({ stitchRate: '', stitchMin: '', setupFee: '', originationFee: '', waiveAtQty: '' });
  const [tiers, setTiers] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setFees({ stitchRate: String(s.stitchRate), stitchMin: String(s.stitchMin), setupFee: String(s.setupFee), originationFee: String(s.originationFee), waiveAtQty: String(s.waiveAtQty) });
    setTiers(s.qtyTiers.map((t) => ({ min: String(t.min), discountPct: String(t.discountPct) })));
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;

  const current: EmbroiderySettingsValues = {
    stitchRate: n(fees.stitchRate),
    stitchMin: n(fees.stitchMin),
    setupFee: n(fees.setupFee),
    originationFee: n(fees.originationFee),
    waiveAtQty: Math.round(n(fees.waiveAtQty)),
    qtyTiers: tiers.map((t) => ({ min: n(t.min), discountPct: n(t.discountPct) })),
  };
  const bands = sortedQtyTiers(current.qtyTiers);

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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--space-4)', alignItems: 'start' }}>
      <Card title="Embroidery pricing" hint="The price by stitches comes first: the rate per 1,000 stitches × the stitches (never less than the minimum). The price by quantity is that price less a quantity discount, so it is lower and never higher. The staff apply either on an order. The setup (digitizing) fee and the design origination fee are their own lines on the order, as before.">
        <Notice error={err} message={msg} />
        <div className="card-kicker">Price by stitches</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', maxWidth: 520 }}>
          <div className="field">
            <label>KES per 1,000 stitches</label>
            <input className="input" inputMode="decimal" value={fees.stitchRate} onChange={(e) => setFees((f) => ({ ...f, stitchRate: e.target.value }))} />
          </div>
          <div className="field">
            <label>Minimum per piece (KES)</label>
            <input className="input" inputMode="numeric" value={fees.stitchMin} onChange={(e) => setFees((f) => ({ ...f, stitchMin: e.target.value }))} />
          </div>
        </div>

        <div className="card-kicker" style={{ marginTop: 'var(--space-3)' }}>Price by quantity — the discount off the price by stitches</div>
        <table className="table" style={{ maxWidth: 520 }}>
          <thead>
            <tr>
              <th>From pieces</th>
              <th>Discount %</th>
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
                  <input className="input" inputMode="decimal" value={t.discountPct} onChange={(e) => setTier(i, { discountPct: e.target.value })} />
                </td>
                <td>
                  {tiers.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this band" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn btn-ghost btn-sm" disabled={tiers.length >= 12} onClick={() => setTiers((ts) => [...ts, { min: '', discountPct: '' }])}>
          + Add a band
        </button>
        <p className="note">The first band must start at 1 piece (usually 0%). A bigger quantity cannot have a smaller discount, so the price by quantity never rises with the quantity.</p>

        <div className="card-kicker" style={{ marginTop: 'var(--space-3)' }}>Other charges (unchanged)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', maxWidth: 720 }}>
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
        <p className="note">Setup is usually KES 1,000–1,500 by complexity; 0 in “waive setup from” means never. Design origination applies only when the client does not bring their own artwork.</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          Save
        </button>
      </Card>

      <Card title="Price per piece — by stitches and by quantity" hint="Updates as you change the numbers above (before you save). The first column is the price by stitches; the others are the price by quantity at the start of each quantity band.">
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th>Stitches</th>
                <th style={right}>By stitches</th>
                {bands.map((b) => (
                  <th key={b.min} style={right}>
                    By quantity
                    <br />
                    {b.min}+ pcs · {b.discountPct}% off
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLE_STITCHES.map((st) => (
                <tr key={st}>
                  <td>{st.toLocaleString('en-KE')}</td>
                  <td style={right}>
                    <b>{fmtKsh(stitchPrice(st, current))}</b>
                  </td>
                  {bands.map((b) => (
                    <td key={b.min} style={right}>
                      {fmtKsh(quantityPrice(st, b.min, current))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
