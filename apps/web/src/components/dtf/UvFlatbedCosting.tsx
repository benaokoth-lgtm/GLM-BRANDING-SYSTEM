import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FLATBED_SIZE_PICKS, flatbedDiscountRangeLabel, flatbedMaxArea, flatbedQuote, flatbedRangeLabel, flatbedSettingsProblem, fmtNum, sortedFlatbedBands, sortedFlatbedDiscounts } from '@glm/shared';
import type { FlatbedSettings } from '@glm/shared';
import { api } from '../../api/client';
import DtfOrderDialog from './DtfOrderDialog';
import UnitDiscountBox from './UnitDiscountBox';
import type { AppliedDiscount } from './UnitDiscountBox';

// UV DTF Film Order → UV Flatbed: the price picker for printing on the flatbed (diaries and other flat items). Staff enter the size of the ARTWORK (the part of the item that is printed)
// and the number of pieces; the band the artwork falls in, the price per piece and the total come from the bands kept in the system. A piece is never charged less than the minimum for
// a piece (what a tiny logo costs), a bigger run gets a volume discount, and the setup fee is added only when it is ticked. A manager changes all of these here. "Capture as order"
// takes the priced job through the usual order popup; the server works the price out again from the same settings. The volume discount and a discount on the unit price are applied only by
// Finance, the General Manager or an Admin (everyone else sees them greyed out, with what the discount would be); the server refuses them from anyone else.

const label = { fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' } as const;
const rule = '2px solid var(--color-divider)';
const money = (n: number) => `${fmtNum(n, 2)}/=`;
const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

interface Editing {
  maxWidthCm: string;
  maxLengthCm: string;
  minPiecePrice: string;
  setupFee: string;
  bands: { upToCm2: string; price: string }[];
  discounts: { from: string; pct: string }[];
  err: string;
  busy: boolean;
}

export default function UvFlatbedCosting() {
  const [settings, setSettings] = useState<FlatbedSettings | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canDiscount, setCanDiscount] = useState(false);
  const [error, setError] = useState('');
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [pieces, setPieces] = useState(0);
  const [withSetup, setWithSetup] = useState(false);
  const [volume, setVolume] = useState(false);
  const [ud, setUd] = useState<AppliedDiscount | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [capturing, setCapturing] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<{ settings: FlatbedSettings; canManage: boolean; canDiscount: boolean }>('/dtf/flatbed')
      .then((r) => {
        setSettings(r.settings);
        setCanManage(r.canManage);
        setCanDiscount(r.canDiscount);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the flatbed prices'));
  }, []);

  if (!settings) return <p className="note">{error || 'Loading…'}</p>;

  const bands = sortedFlatbedBands(settings.bands);
  const discounts = sortedFlatbedDiscounts(settings.discounts);
  const wc = num(w);
  const hc = num(h);
  const unitDiscount = ud ? { kind: ud.kind, value: ud.value } : null;
  const jobSpec = wc > 0 && hc > 0 && pieces > 0 ? { widthCm: wc, heightCm: hc, pieces } : null;
  const volumeOn = canDiscount && volume;
  const q = flatbedQuote(settings, wc, hc, pieces, { setup: withSetup, volume: volumeOn, unitDiscount });
  const sized = wc > 0 && hc > 0;
  const startEdit = () =>
    setEditing({
      maxWidthCm: String(settings.maxWidthCm),
      maxLengthCm: String(settings.maxLengthCm),
      minPiecePrice: String(settings.minPiecePrice),
      setupFee: String(settings.setupFee),
      bands: bands.map((b) => ({ upToCm2: String(b.upToCm2), price: String(b.price) })),
      discounts: discounts.map((d) => ({ from: String(d.from), pct: String(d.pct) })),
      err: '',
      busy: false,
    });

  async function saveEdit() {
    if (!editing) return;
    const next: FlatbedSettings = {
      maxWidthCm: Number(editing.maxWidthCm),
      maxLengthCm: Number(editing.maxLengthCm),
      minPiecePrice: Number(editing.minPiecePrice),
      setupFee: Number(editing.setupFee),
      bands: editing.bands.map((b) => ({ upToCm2: Number(b.upToCm2), price: Number(b.price) })),
      discounts: editing.discounts.map((d) => ({ from: Math.round(Number(d.from)), pct: Number(d.pct) })),
    };
    const nums = [next.maxWidthCm, next.maxLengthCm, next.minPiecePrice, next.setupFee, ...next.bands.flatMap((b) => [b.upToCm2, b.price]), ...next.discounts.flatMap((d) => [d.from, d.pct])];
    const problem = nums.some((n) => !Number.isFinite(n)) ? 'Fill in every box with a number' : flatbedSettingsProblem(next);
    if (problem) return setEditing({ ...editing, err: problem });
    setEditing({ ...editing, busy: true, err: '' });
    try {
      const r = await api.put<{ settings: FlatbedSettings; canManage: boolean }>('/dtf/flatbed', next);
      setSettings(r.settings);
      setEditing(null);
    } catch (e) {
      setEditing({ ...editing, busy: false, err: e instanceof Error ? e.message : 'Could not save the prices' });
    }
  }

  const setBand = (i: number, patch: Partial<{ upToCm2: string; price: string }>) => editing && setEditing({ ...editing, bands: editing.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const setDiscount = (i: number, patch: Partial<{ from: string; pct: string }>) => editing && setEditing({ ...editing, discounts: editing.discounts.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const field = (k: 'maxWidthCm' | 'maxLengthCm' | 'minPiecePrice' | 'setupFee', text: string, unit: string) =>
    editing && (
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <span style={{ width: 190 }}>{text}</span>
        <input className="input" style={{ width: 90 }} inputMode="decimal" value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
        <span className="text-muted">{unit}</span>
      </label>
    );

  return (
    <div className="card blueprint" style={{ padding: 0 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '20px 32px', borderBottom: rule }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>UV Flatbed · Diaries &amp; flat items · Price Picker</div>
        <button type="button" className="btn btn-ghost" onClick={() => { setW(''); setH(''); setPieces(0); setNote(''); setWithSetup(false); setVolume(false); setUd(null); }}>Clear</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        {/* the input */}
        <div style={{ padding: 32, borderBottom: rule, borderRight: rule }}>
          <div style={label}>Artwork size (cm)</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <input className="input" style={{ flex: 1, minWidth: 0, fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-heading)' }} inputMode="decimal" placeholder="width" value={w} onChange={(e) => setW(e.target.value)} aria-label="Artwork width in cm" />
            <span style={{ fontSize: 24 }}>×</span>
            <input className="input" style={{ flex: 1, minWidth: 0, fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-heading)' }} inputMode="decimal" placeholder="height" value={h} onChange={(e) => setH(e.target.value)} aria-label="Artwork height in cm" />
          </div>
          <p className="note" style={{ margin: '6px 0 0', fontSize: 13 }}>The part that is printed, not the whole item.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {FLATBED_SIZE_PICKS.map((p) => (
              <button key={p.label} type="button" className="btn btn-secondary btn-sm" onClick={() => { setW(String(p.w)); setH(String(p.h)); }} title={`${p.w} × ${p.h} cm`}>
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ ...label, marginTop: 28 }}>Number of pieces</div>
          <div style={{ display: 'flex', border: rule, marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" style={{ width: 72, fontSize: 28 }} aria-label="One fewer piece" onClick={() => setPieces(Math.max(0, pieces - 1))}>−</button>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0, fontSize: 56, fontWeight: 700, padding: '12px 16px', border: 0, textAlign: 'left', fontFamily: 'var(--font-heading)' }}
              inputMode="numeric"
              placeholder="0"
              value={pieces ? String(pieces) : ''}
              onChange={(e) => setPieces(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
              aria-label="Number of pieces"
            />
            <button type="button" className="btn btn-secondary" style={{ width: 72, fontSize: 28 }} aria-label="One more piece" onClick={() => setPieces(pieces + 1)}>+</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12 }}>
            {[1, 10, 20, 50, 100, 200, 500, 1000].map((n) => (
              <button key={n} type="button" className="btn btn-secondary" onClick={() => setPieces(n)}>{n.toLocaleString()}</button>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 18, fontSize: 15 }}>
            <input type="checkbox" checked={withSetup} onChange={(e) => setWithSetup(e.target.checked)} aria-label="Add the setup fee" />
            <span>Add the setup fee ({money(settings.setupFee)}), for the layout</span>
          </label>
          <div style={{ border: rule, padding: 14, marginTop: 18, display: 'grid', gap: 10 }}>
            <div style={{ ...label, fontSize: 13 }}>Discounts {canDiscount ? '' : '· the volume discount is applied by Finance, the General Manager or an Admin'}</div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15, opacity: canDiscount ? 1 : 0.6 }}>
              <input type="checkbox" checked={volumeOn} disabled={!canDiscount} onChange={(e) => setVolume(e.target.checked)} aria-label="Apply the volume discount" />
              <span>Apply the volume discount{q.ok && q.volumePct > 0 ? ` (${fmtNum(q.volumePct, 2)}% for ${fmtNum(q.pieces)} pieces)` : ''}</span>
            </label>
            {!canDiscount && q.ok && q.volumePct > 0 && <p className="note" style={{ margin: 0, fontSize: 13 }}>This run earns {fmtNum(q.volumePct, 2)}% off. Ask Finance, the General Manager or an Admin to apply it.</p>}
            <UnitDiscountBox product="flatbed" spec={jobSpec} canGive={canDiscount} applied={ud} onChange={setUd} />
          </div>
          <input className="input" style={{ marginTop: 14 }} maxLength={100} placeholder="What it is, e.g. 2027 diary covers (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="What is being printed" />

          <div style={{ marginTop: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={label}>Price by artwork size</div>
            {canManage && !editing && <button type="button" className="btn btn-ghost btn-sm" onClick={startEdit}>Edit prices</button>}
          </div>
          {!editing ? (
            <>
              <div style={{ borderTop: rule, marginTop: 8 }}>
                {bands.map((b, i) => {
                  const on = q.ok && q.bandIndex === i;
                  return (
                    <div key={b.upToCm2} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--color-divider)', alignItems: 'center', background: on ? 'var(--color-accent)' : 'transparent', color: on ? '#fff' : 'inherit' }}>
                      <span style={{ fontWeight: 600 }}>{flatbedRangeLabel(bands, i)}</span>
                      <span><b>{fmtNum(Math.max(b.price, settings.minPiecePrice), 2)}</b> /= each</span>
                    </div>
                  );
                })}
              </div>
              <p className="note" style={{ marginBottom: 0, fontSize: 13 }}>
                The largest artwork is {fmtNum(settings.maxWidthCm)} × {fmtNum(settings.maxLengthCm)} cm ({fmtNum(flatbedMaxArea(settings))} cm²). A piece is never charged less than {money(settings.minPiecePrice)}, however small the artwork.
              </p>
                <div style={{ ...label, marginTop: 24 }}>Volume discount</div>
              <div style={{ borderTop: rule, marginTop: 8 }}>
                {discounts.map((d, i) => (
                  <div key={d.from} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--color-divider)', alignItems: 'center', background: q.ok && q.discountIndex === i ? 'var(--color-accent)' : 'transparent', color: q.ok && q.discountIndex === i ? '#fff' : 'inherit' }}>
                    <span style={{ fontWeight: 600 }}>{flatbedDiscountRangeLabel(discounts, i)} pieces</span>
                    <span>{d.pct > 0 ? <b>{fmtNum(d.pct, 2)}% off</b> : 'no discount'}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ borderTop: rule, marginTop: 8, display: 'grid', gap: 8, paddingTop: 12 }}>
              {field('minPiecePrice', 'Minimum price for a piece', '/=')}
              {field('setupFee', 'Setup fee (when ticked)', '/=')}
              {field('maxWidthCm', 'Largest artwork width', 'cm')}
              {field('maxLengthCm', 'Largest artwork length', 'cm')}
              <div style={{ ...label, marginTop: 8 }}>Bands</div>
              {editing.bands.map((b, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="text-muted" style={{ fontSize: 13 }}>Up to</span>
                  <input className="input" style={{ width: 90 }} inputMode="decimal" value={b.upToCm2} onChange={(e) => setBand(i, { upToCm2: e.target.value })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>cm² at</span>
                  <input className="input" style={{ width: 80 }} inputMode="decimal" value={b.price} onChange={(e) => setBand(i, { price: e.target.value })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>/= each</span>
                  {editing.bands.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, bands: editing.bands.filter((_, j) => j !== i) })}>Remove</button>}
                </div>
              ))}
              <div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, bands: [...editing.bands, { upToCm2: '', price: '' }] })}>+ Add a band</button>
              </div>
              <div style={{ ...label, marginTop: 8 }}>Volume discount</div>
              {editing.discounts.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="text-muted" style={{ fontSize: 13 }}>From</span>
                  <input className="input" style={{ width: 80 }} inputMode="numeric" value={d.from} disabled={i === 0} onChange={(e) => setDiscount(i, { from: e.target.value })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>pieces:</span>
                  <input className="input" style={{ width: 70 }} inputMode="decimal" value={d.pct} onChange={(e) => setDiscount(i, { pct: e.target.value })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>% off</span>
                  {i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, discounts: editing.discounts.filter((_, j) => j !== i) })}>Remove</button>}
                </div>
              ))}
              <div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, discounts: [...editing.discounts, { from: '', pct: '' }] })}>+ Add a discount line</button>
              </div>
              {editing.err && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{editing.err}</p>}
              <div>
                <button type="button" className="btn btn-primary btn-sm" disabled={editing.busy} onClick={saveEdit}>Save prices</button>{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
          {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
        </div>

        {/* the output */}
        <div style={{ padding: 32, borderBottom: rule, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div>
            <div style={label}>Price per piece</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 96, lineHeight: 1, color: 'var(--color-accent)', marginTop: 8 }}>{q.band ? money(q.discountedUnit) : '—'}</div>
            <div style={{ fontSize: 15, marginTop: 4 }}>
              {sized ? (q.band ? `${fmtNum(q.areaCm2, 1)} cm² · ${flatbedRangeLabel(bands, q.bandIndex)}${q.minApplied ? ' · the minimum price for a piece' : ''}${q.unitDiscount > 0 ? ` · ${money(q.unitPrice)} less ${money(q.unitDiscount)}` : ''}` : `${fmtNum(wc * hc, 1)} cm² — no price`) : 'Enter the artwork size'}
            </div>
          </div>
          {q.problem && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{q.problem}</p>}
          {q.ok && (
            <div style={{ borderTop: rule, paddingTop: 16 }}>
              <div style={label}>Total to charge</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 64, lineHeight: 1.1 }}>{money(q.total)}</div>
              <div style={{ fontSize: 15, marginTop: 8, display: 'grid', gap: 2 }}>
                <span>{fmtNum(q.pieces)} × {money(q.discountedUnit)} = {money(q.gross)}</span>
                {q.volumeApplied && <span>Volume discount {fmtNum(q.volumePct, 2)}% = −{money(q.discount)}</span>}
                {q.setupFee > 0 && <span>Setup fee +{money(q.setupFee)}</span>}
                <span className="text-muted">About {money(q.perPiece)} a piece all in. VAT included, as every price in the system is.</span>
              </div>
            </div>
          )}
          {q.ok && canDiscount && q.upsell && (
            <div style={{ border: '2px solid var(--color-accent)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
              <div>
                <b>Discount close by:</b> add {fmtNum(q.upsell.add)} more {q.upsell.add === 1 ? 'piece' : 'pieces'} ({fmtNum(q.upsell.qty)} in all) → {fmtNum(q.upsell.pct, 2)}% off.{' '}
                {q.upsell.saving > 0 ? `The customer pays ${money(q.upsell.saving)} less overall.` : `The total becomes ${money(q.printTotal - q.upsell.saving)}.`}
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setPieces(q.upsell!.qty)}>Set to {fmtNum(q.upsell.qty)} pieces</button>
            </div>
          )}
          {q.ok && (
            <div>
              <button type="button" className="btn btn-primary blueprint" onClick={() => setCapturing(true)}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Capture as order
              </button>
            </div>
          )}
        </div>
      </div>
      {capturing && q.ok && (
        <DtfOrderDialog
          product="uv"
          mode="flatbed"
          postUrl="/dtf/flatbed-orders"
          basePayload={{ widthCm: wc, heightCm: hc, pieces, withSetup, note, volumeDiscount: volumeOn, unitDiscount: ud && !ud.requestId ? { kind: ud.kind, value: ud.value } : null, discountRequestId: ud?.requestId ?? null }}
          qty={1}
          unitPrice={q.total}
          client=""
          onClose={() => setCapturing(false)}
          onDone={() => navigate('/orders/all')}
        />
      )}
    </div>
  );
}
