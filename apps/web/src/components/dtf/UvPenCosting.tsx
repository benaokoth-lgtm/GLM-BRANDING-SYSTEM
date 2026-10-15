import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PEN_QUICK_PICKS, fmtNum, penQuote, penRangeLabel, penTiersProblem, sortedPenTiers } from '@glm/shared';
import type { PenTier } from '@glm/shared';
import { api } from '../../api/client';
import DtfOrderDialog from './DtfOrderDialog';
import UnitDiscountBox from './UnitDiscountBox';
import type { AppliedDiscount } from './UnitDiscountBox';

// UV DTF Film Order → UV Pen Costing: the price picker for UV-printed pen branding. Staff enter the number of pens and the rate per pen and the total to charge come from the tier
// table — the whole order at the one rate for its quantity — so nobody has to ask for the price. When the customer is a few pens short of a cheaper tier it says so, and one tap
// sets the order to that quantity. A manager changes the rates here; they are kept in the system, for everyone. "Capture as order" takes the priced pens through the usual order
// popup (client, merchandise, payment); the server works the rate out again from the tiers.

const label = { fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' } as const;
const rule = '2px solid var(--color-divider)';
const rateText = (n: number) => `${fmtNum(n, 2)}/=`;
const money = (n: number) => `${fmtNum(n, 2)}/=`;

interface Editing {
  rows: { from: string; rate: string }[];
  err: string;
  busy: boolean;
}

export default function UvPenCosting({ requestId }: { requestId?: number }) {
  const [tiers, setTiers] = useState<PenTier[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canGive, setCanGive] = useState(false);
  const [ud, setUd] = useState<AppliedDiscount | null>(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [capturing, setCapturing] = useState(false);
  const navigate = useNavigate();

  // opened from the approvals inbox: the pens of that request are filled in, and its discount is applied when it is approved and yours
  useEffect(() => {
    if (!requestId) return;
    api
      .get<{ requests: { id: number; spec: { pens?: number }; kind: 'amount' | 'pct'; value: number; status: string; mine: boolean }[] }>('/dtf/discount-requests?product=pens')
      .then((r) => {
        const x = r.requests.find((q) => q.id === requestId);
        if (!x?.spec.pens) return;
        setQty(x.spec.pens);
        if (x.status === 'Approved' && x.mine) setUd({ kind: x.kind, value: x.value, requestId: x.id });
      })
      .catch(() => undefined);
  }, [requestId]);

  useEffect(() => {
    api
      .get<{ tiers: PenTier[]; canManage: boolean; canDiscount?: boolean }>('/dtf/pen-tiers')
      .then((r) => {
        setTiers(sortedPenTiers(r.tiers));
        setCanManage(r.canManage);
        setCanGive(!!r.canDiscount);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the pen rates'));
  }, []);

  if (!tiers) return <p className="note">{error || 'Loading…'}</p>;

  const q = penQuote(tiers, qty, ud ? { kind: ud.kind, value: ud.value } : null);
  const penSpec = qty > 0 ? { pens: qty } : null;
  const set = (n: number) => setQty(Math.max(0, Math.floor(n) || 0));
  const u = q.upsell;

  async function saveTiers(rows: { from: number; rate: number }[]) {
    return api.put<{ tiers: PenTier[]; canManage: boolean }>('/dtf/pen-tiers', { tiers: rows });
  }
  // a rate typed straight into the table
  async function setRate(i: number, value: string) {
    const v = parseFloat(value);
    if (!(v >= 0) || !Number.isFinite(v) || v === tiers![i]!.rate) return;
    try {
      const r = await saveTiers(tiers!.map((t, j) => (j === i ? { ...t, rate: v } : t)));
      setTiers(sortedPenTiers(r.tiers));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rate');
    }
  }
  async function saveEdit() {
    if (!editing) return;
    const rows = editing.rows.map((r) => ({ from: Math.round(Number(r.from)), rate: Number(r.rate) }));
    const problem = penTiersProblem(rows);
    if (problem || rows.some((r) => !Number.isFinite(r.from) || !Number.isFinite(r.rate))) return setEditing({ ...editing, err: problem ?? 'Fill in every tier' });
    setEditing({ ...editing, busy: true, err: '' });
    try {
      const r = await saveTiers(rows);
      setTiers(sortedPenTiers(r.tiers));
      setEditing(null);
    } catch (e) {
      setEditing({ ...editing, busy: false, err: e instanceof Error ? e.message : 'Could not save the rates' });
    }
  }

  const range = (i: number) => `${penRangeLabel(tiers, i)} pens`;

  return (
    <div className="card blueprint" style={{ padding: 0 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '20px 32px', borderBottom: rule }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>UV Pen Branding · Price Picker</div>
        <button type="button" className="btn btn-ghost" onClick={() => { setQty(0); setUd(null); }}>Clear</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        {/* the input */}
        <div style={{ padding: 32, borderBottom: rule, borderRight: rule }}>
          <div style={label}>Number of pens</div>
          <div style={{ display: 'flex', border: rule, marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" style={{ width: 72, fontSize: 28 }} aria-label="One fewer pen" onClick={() => set(qty - 1)}>−</button>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0, fontSize: 56, fontWeight: 700, padding: '12px 16px', border: 0, textAlign: 'left', fontFamily: 'var(--font-heading)' }}
              inputMode="numeric"
              placeholder="0"
              value={qty ? String(qty) : ''}
              onChange={(e) => set(parseInt(e.target.value, 10))}
              aria-label="Number of pens"
            />
            <button type="button" className="btn btn-secondary" style={{ width: 72, fontSize: 28 }} aria-label="One more pen" onClick={() => set(qty + 1)}>+</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12 }}>
            {PEN_QUICK_PICKS.map((n) => (
              <button key={n} type="button" className="btn btn-secondary" onClick={() => set(n)}>{n.toLocaleString()}</button>
            ))}
          </div>

          <div style={{ border: rule, padding: 14, marginTop: 24 }}>
            <UnitDiscountBox product="pens" spec={penSpec} canGive={canGive} applied={ud} onChange={setUd} />
          </div>

          <div style={{ marginTop: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={label}>Rate tiers</div>
            {canManage && !editing && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ rows: tiers.map((t) => ({ from: String(t.from), rate: String(t.rate) })), err: '', busy: false })}>Edit tiers</button>
            )}
          </div>
          {!editing ? (
            <div style={{ borderTop: rule, marginTop: 8 }}>
              {tiers.map((t, i) => {
                const on = q.tier === t;
                return (
                  <div key={t.from} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '10px 12px', borderBottom: '1px solid var(--color-divider)', alignItems: 'center', background: on ? 'var(--color-accent)' : 'transparent', color: on ? '#fff' : 'inherit' }}>
                    <span style={{ fontWeight: 600 }}>{range(i)}</span>
                    <span>
                      {canManage ? (
                        <input
                          key={`${t.from}-${t.rate}`}
                          className="input"
                          style={{ width: 64, padding: '4px 8px', border: rule, fontWeight: 700, textAlign: 'right', color: 'inherit', background: on ? 'rgba(255,255,255,.15)' : undefined }}
                          inputMode="decimal"
                          defaultValue={t.rate}
                          aria-label={`Rate for ${range(i)}`}
                          onBlur={(e) => setRate(i, e.target.value)}
                        />
                      ) : (
                        <b>{fmtNum(t.rate, 2)}</b>
                      )}{' '}
                      /= each
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ borderTop: rule, marginTop: 8, display: 'grid', gap: 8, paddingTop: 12 }}>
              {editing.rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="text-muted" style={{ fontSize: 13 }}>From</span>
                  <input className="input" style={{ width: 80 }} inputMode="numeric" value={r.from} disabled={i === 0} onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>pens at</span>
                  <input className="input" style={{ width: 80 }} inputMode="decimal" value={r.rate} onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)) })} />
                  <span className="text-muted" style={{ fontSize: 13 }}>/= each</span>
                  {i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, rows: editing.rows.filter((_, j) => j !== i) })}>Remove</button>}
                </div>
              ))}
              <div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, rows: [...editing.rows, { from: '', rate: '' }] })}>+ Add a tier</button>
              </div>
              {editing.err && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{editing.err}</p>}
              <div>
                <button type="button" className="btn btn-primary btn-sm" disabled={editing.busy} onClick={saveEdit}>Save tiers</button>{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
          {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
          <p className="note" style={{ marginBottom: 0, fontSize: 13 }}>
            {canManage ? 'Tap a rate to change it. ' : ''}
            Boundaries: {tiers.map((_, i) => penRangeLabel(tiers, i)).join(' · ')}. The whole order is charged at the one rate for its quantity.
          </p>
        </div>

        {/* the output */}
        <div style={{ padding: 32, borderBottom: rule, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div>
            <div style={label}>Price per pen</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 112, lineHeight: 1, color: 'var(--color-accent)', marginTop: 8 }}>{qty ? rateText(q.discountedRate) : '—'}</div>
            {qty > 0 && q.unitDiscount > 0 && <div style={{ fontSize: 15, marginTop: 4 }}>{rateText(q.rate)} less {rateText(q.unitDiscount)} (unit price discount)</div>}
          </div>
          <div style={{ borderTop: rule, paddingTop: 16 }}>
            <div style={label}>Total to charge</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 72, lineHeight: 1.1 }}>{qty ? money(q.total) : '—'}</div>
            <div style={{ fontSize: 16, marginTop: 4 }}>{qty ? `${fmtNum(qty)} pens × ${rateText(q.discountedRate)}` : 'Enter the number of pens'}</div>
            {qty > 0 && <div className="text-muted" style={{ fontSize: 13, marginTop: 2 }}>VAT included, as every price in the system is.</div>}
          </div>
          {qty > 0 && u && (
            <div style={{ border: '2px solid var(--color-accent)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
              <div>
                <b>Upsell:</b> Add {fmtNum(u.add)} more pens ({fmtNum(u.qty)} total) → {rateText(u.rate)} each.{' '}
                {u.saving > 0 ? `Customer pays ${money(u.saving)} less overall.` : u.saving === 0 ? 'The same total, for more pens.' : `Total becomes ${money(u.newTotal)}.`}
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={() => set(u.qty)}>Set to {fmtNum(u.qty)} pens</button>
            </div>
          )}
          {qty > 0 && (
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
      {capturing && qty > 0 && (
        <DtfOrderDialog
          product="uv"
          mode="pens"
          postUrl="/dtf/pen-orders"
          basePayload={{ pens: qty, unitDiscount: ud && !ud.requestId ? { kind: ud.kind, value: ud.value } : null, discountRequestId: ud?.requestId ?? null }}
          qty={qty}
          unitPrice={q.discountedRate}
          client=""
          onClose={() => setCapturing(false)}
          onDone={() => navigate('/orders/all')}
        />
      )}
    </div>
  );
}
