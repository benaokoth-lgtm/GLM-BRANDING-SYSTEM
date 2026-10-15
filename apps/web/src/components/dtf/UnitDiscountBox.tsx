import { useCallback, useEffect, useState } from 'react';
import { fmtNum } from '@glm/shared';
import type { UnitDiscount } from '@glm/shared';
import { api } from '../../api/client';

// The unit price discount of UV Pen Costing and UV Flatbed. Finance Manager, General Manager and Admin give it straight away: they choose "Ksh off each" or "% off" and type the amount. Anyone
// else asks: the request is for this job (the pens, or the artwork size and the number of pieces), one of those three decides it, and once it is approved the person who asked applies it and
// captures the order. The order is priced again from the request on the server, so what is typed here never decides the discount.

export interface AppliedDiscount extends UnitDiscount {
  /** Set when the discount comes from an approved request (not given outright). */
  requestId?: number;
}

interface Request {
  id: number;
  product: 'pens' | 'flatbed';
  spec: Record<string, number>;
  kind: 'amount' | 'pct';
  value: number;
  unitBefore: number;
  unitAfter: number;
  requestedByName: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Used';
  decidedByName: string | null;
  reason: string | null;
  orderNo: string;
  mine: boolean;
}

const label = { fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' } as const;
const rule = '2px solid var(--color-divider)';
const off = (r: { kind: string; value: number }) => (r.kind === 'pct' ? `${fmtNum(r.value, 2)}% off` : `${fmtNum(r.value, 2)}/= off each`);
const jobText = (product: string, spec: Record<string, number>) => (product === 'pens' ? `${fmtNum(spec.pens ?? 0)} pens` : `${spec.pieces} × ${spec.widthCm} × ${spec.heightCm} cm`);
const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

interface Props {
  product: 'pens' | 'flatbed';
  /** The job as it stands now ({pens} or {widthCm, heightCm, pieces}, in that key order), or null while it is not complete. */
  spec: Record<string, number> | null;
  /** Whether the person may give a discount outright (Finance Manager, General Manager, Admin). */
  canGive: boolean;
  applied: AppliedDiscount | null;
  onChange: (d: AppliedDiscount | null) => void;
}

export default function UnitDiscountBox({ product, spec, canGive, applied, onChange }: Props) {
  const [kind, setKind] = useState<'amount' | 'pct'>('amount');
  const [value, setValue] = useState('');
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const specText = spec ? JSON.stringify(spec) : '';

  const load = useCallback(() => {
    api
      .get<{ requests: Request[] }>(`/dtf/discount-requests?product=${product}`)
      .then((r) => setRequests(r.requests))
      .catch(() => undefined);
  }, [product]);
  useEffect(load, [load]);

  // Finance, the General Manager and Admin: whatever is typed is the discount
  useEffect(() => {
    if (!canGive) return;
    const v = num(value);
    onChange(v > 0 ? { kind, value: v } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canGive, kind, value]);

  // an approved discount is for one job: when the job changes, it is no longer applied
  useEffect(() => {
    if (applied?.requestId && applied.requestId !== undefined) {
      const r = requests.find((x) => x.id === applied.requestId);
      if (r && JSON.stringify(r.spec) !== specText) onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specText]);

  async function ask() {
    if (!spec) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/dtf/discount-requests', { product, ...spec, discount: { kind, value: num(value) } });
      setValue('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setBusy(false);
    }
  }
  async function decide(id: number, approve: boolean, reason = '') {
    setBusy(true);
    setError('');
    try {
      await api.post(`/dtf/discount-requests/${id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { reason });
      setRejecting(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the decision');
    } finally {
      setBusy(false);
    }
  }

  const waiting = requests.filter((r) => r.status === 'Pending' && !r.mine);
  const mine = requests.filter((r) => r.mine && !(r.status === 'Used'));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={label}>Unit price discount {canGive ? '' : '· needs approval'}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 170 }} value={kind} onChange={(e) => setKind(e.target.value as 'amount' | 'pct')} aria-label="Kind of unit price discount">
          <option value="amount">Ksh off each piece</option>
          <option value="pct">% off the unit price</option>
        </select>
        <input className="input" style={{ width: 90 }} inputMode="decimal" placeholder={kind === 'pct' ? '%' : 'Ksh'} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Unit price discount" />
        {!canGive && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !spec || !(num(value) > 0)} onClick={ask}>
            Ask for approval
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} title="See what has been decided">Refresh</button>
      </div>
      {!canGive && !spec && <p className="note" style={{ margin: 0, fontSize: 13 }}>Enter the {product === 'pens' ? 'number of pens' : 'artwork size and the number of pieces'} first: the discount is approved for that job.</p>}
      {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}

      {/* what the person asked for, and how it went */}
      {!canGive && mine.length > 0 && (
        <div style={{ borderTop: rule }}>
          {mine.map((r) => {
            const same = JSON.stringify(r.spec) === specText;
            const on = applied?.requestId === r.id;
            return (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--color-divider)', fontSize: 14 }}>
                <span><b>{off(r)}</b> · {jobText(r.product, r.spec)} · {fmtNum(r.unitBefore, 2)}/= → {fmtNum(r.unitAfter, 2)}/= each</span>
                {r.status === 'Pending' && <span className="tag tag-outline">waiting for approval</span>}
                {r.status === 'Rejected' && <span className="tag tag-outline">turned down{r.reason ? `: ${r.reason}` : ''}</span>}
                {r.status === 'Approved' && !on && same && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onChange({ kind: r.kind, value: r.value, requestId: r.id })}>Apply the approved discount</button>
                )}
                {r.status === 'Approved' && !on && !same && <span className="text-muted">approved for that job only</span>}
                {r.status === 'Approved' && on && (
                  <>
                    <span className="tag tag-accent">applied</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Remove</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* those who decide: what is waiting */}
      {canGive && waiting.length > 0 && (
        <div style={{ border: '2px solid var(--color-accent)', padding: 12, display: 'grid', gap: 8 }}>
          <div style={label}>Waiting for your decision</div>
          {waiting.map((r) => (
            <div key={r.id} style={{ display: 'grid', gap: 6, fontSize: 14 }}>
              <div>
                <b>{r.requestedByName}</b> asks for <b>{off(r)}</b> on {jobText(r.product, r.spec)} ({fmtNum(r.unitBefore, 2)}/= → {fmtNum(r.unitAfter, 2)}/= each)
              </div>
              {rejecting?.id === r.id ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Why it is turned down" value={rejecting.reason} onChange={(e) => setRejecting({ id: r.id, reason: e.target.value })} aria-label="Reason for turning the discount down" />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !rejecting.reason.trim()} onClick={() => decide(r.id, false, rejecting.reason)}>Turn down</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(null)}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(r.id, true)}>Approve</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRejecting({ id: r.id, reason: '' })}>Turn down</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
