import { useCallback, useEffect, useState } from 'react';
import { computeOrderTotals, fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { DraftLineItem, OrderDetail } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import LineItemsEditor, { isBlankLine } from './LineItemsEditor';

// Under the order: amend or delete it after approval. The person who needs the change asks with a reason; Finance or the Admin approves it in the Approvals inbox; then the person who asked makes the
// change here, once. Film, artwork and embroidery orders and completed orders are not changed this way; an order with payments cannot be deleted until its payments are moved or refunded.

interface Request {
  id: number;
  kind: 'Amend' | 'Delete';
  reason: string;
  status: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  doneAt: string | null;
  mine: boolean;
}
interface Info {
  requests: Request[];
  problem: string | null;
  hasPayments: boolean;
}

const toDraft = (li: OrderDetail['lineItems'][number]): DraftLineItem => ({
  itemType: li.itemType,
  serviceId: li.serviceId,
  materialId: li.materialId,
  qty: li.qty,
  unitPrice: li.unitPrice,
  discountPct: li.discountPct,
  discountAmt: li.discountAmt,
  discountMode: li.discountAmt > 0 ? 'amt' : 'pct',
  heatPressFee: li.heatPressFee ?? '',
  artworkAreaSqm: li.artworkAreaSqm ?? '',
});

export default function OrderChangePanel({ detail, onChanged, onDeleted }: { detail: OrderDetail; onChanged: () => void; onDeleted: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [asking, setAsking] = useState<'Amend' | 'Delete' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [amending, setAmending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    api.get<Info>(`/order-changes/orders/${detail.id}`).then(setInfo).catch(() => setInfo(null));
  }, [detail.id]);
  useEffect(load, [load]);

  if (!info) return null;
  const open = info.requests.find((r) => r.status === 'Pending' || r.status === 'Approved');
  const history = info.requests.filter((r) => r !== open);

  async function ask() {
    if (!asking) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/order-changes/orders/${detail.id}`, { kind: asking, reason: reason.trim() });
      setAsking(null);
      setReason('');
      setNote('Sent for approval. It appears in the Approvals inbox of Finance and the Admin; once approved, come back here to make the change.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setBusy(false);
    }
  }
  async function act(path: string, done: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(path);
      setNote(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api.del(`/order-changes/orders/${detail.id}`);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the order');
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="no-print" style={{ borderTop: '1px solid var(--color-divider)', padding: 'var(--space-3) 0', marginTop: 'var(--space-3)' }}>
      <div className="card-kicker">Amend or delete this order</div>
      {error && <p className="note" role="alert" style={{ color: 'var(--color-error)', fontWeight: 700 }}>{error}</p>}
      {note && <p className="note" role="status">{note}</p>}

      {info.problem && !open && <p className="note" style={{ margin: 0 }}>{info.problem}.</p>}

      {!open && !info.problem && !asking && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setAsking('Amend'); setNote(''); }}>Ask to amend…</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAsking('Delete'); setNote(''); }}>Ask to delete…</button>
          <span className="note" style={{ margin: 0 }}>A manager approves it first; then you make the change.</span>
        </div>
      )}

      {asking && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0, flex: '1 1 320px' }}>
            <label>Why does this order need to be {asking === 'Amend' ? 'amended' : 'deleted'}? (required)</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={asking === 'Amend' ? 'e.g. customer added a banner and changed the quantity' : 'e.g. captured twice by mistake'} autoFocus />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 3} onClick={ask}>Send for approval</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAsking(null); setReason(''); }}>Cancel</button>
        </div>
      )}

      {open?.status === 'Pending' && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="tag tag-outline">Waiting for approval</span>
          <span>
            {open.requestedByName} asked to <b>{open.kind === 'Amend' ? 'amend' : 'delete'}</b> this order: {open.reason}
          </span>
          {open.mine && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(`/order-changes/requests/${open.id}/cancel`, 'Request withdrawn.')}>Withdraw</button>}
        </div>
      )}

      {open?.status === 'Approved' && (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <div>
            <span className="tag tag-accent">Approved</span> by {open.decidedByName}
            {open.decidedAt ? ` on ${fmtDate(open.decidedAt.slice(0, 10))}` : ''}: {open.kind === 'Amend' ? 'amend' : 'delete'} this order — {open.reason}.
            {open.decisionNote && <> Note: {open.decisionNote}</>}
          </div>
          {open.mine ? (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              {open.kind === 'Amend' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAmending(true)}>Amend the order now</button>}
              {open.kind === 'Delete' && !confirmDelete && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirmDelete(true)}>Delete the order now</button>
              )}
              {open.kind === 'Delete' && confirmDelete && (
                <>
                  <b>Delete order {detail.orderNo} for good?</b>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={remove}>Yes, delete it</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>No</button>
                </>
              )}
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(`/order-changes/requests/${open.id}/cancel`, 'Request withdrawn.')}>Withdraw</button>
              {open.kind === 'Delete' && info.hasPayments && <span className="note" style={{ margin: 0 }}>This order has payments: move or refund them first (Accounting → M-Pesa Matching → Matched payments, or a credit note).</span>}
            </div>
          ) : (
            <span className="note" style={{ margin: 0 }}>Only {open.requestedByName} can make the change.</span>
          )}
        </div>
      )}

      {history.length > 0 && (
        <p className="note" style={{ marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide' : 'Show'} earlier requests ({history.length})</button>
          {showHistory && (
            <span style={{ display: 'grid', gap: 2, marginTop: 4 }}>
              {history.map((h) => (
                <span key={h.id}>
                  {fmtDate(h.requestedAt.slice(0, 10))} — {h.kind === 'Amend' ? 'amendment' : 'deletion'} asked by {h.requestedByName} ({h.reason}): <b>{h.status}</b>
                  {h.decidedByName ? ` by ${h.decidedByName}` : ''}
                  {h.decisionNote ? ` — ${h.decisionNote}` : ''}
                </span>
              ))}
            </span>
          )}
        </p>
      )}

      {amending && open?.kind === 'Amend' && (
        <AmendDialog
          detail={detail}
          onClose={() => setAmending(false)}
          onDone={() => {
            setAmending(false);
            setNote('The order was amended.');
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function AmendDialog({ detail, onClose, onDone }: { detail: OrderDetail; onClose: () => void; onDone: () => void }) {
  const { services, materials } = useCatalog();
  const [name, setName] = useState(detail.kind === 'corporate' ? '' : detail.customerName ?? '');
  const [phone, setPhone] = useState(detail.phone ?? '');
  const [lines, setLines] = useState<DraftLineItem[]>(() => detail.lineItems.map(toDraft));
  const [discPct, setDiscPct] = useState(String(detail.orderDiscountPct ?? 0));
  const [discAmt, setDiscAmt] = useState(String(detail.orderDiscountAmt ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const normalized = lines
    .filter((li) => !isBlankLine(li))
    .map((li) => ({
      itemType: li.itemType,
      serviceId: li.serviceId != null ? Number(li.serviceId) : null,
      materialId: li.materialId,
      qty: Number(li.qty) || 0,
      unitPrice: Number(li.unitPrice) || 0,
      discountPct: Number(li.discountPct) || 0,
      discountAmt: Number(li.discountAmt) || 0,
      heatPressFee: Number(li.heatPressFee) > 0 ? Number(li.heatPressFee) : undefined,
      artworkAreaSqm: Number(li.artworkAreaSqm) > 0 ? Number(li.artworkAreaSqm) : undefined,
    }));
  const totals = computeOrderTotals({ lineItems: normalized, orderDiscountPct: Number(discPct) || 0, orderDiscountAmt: Number(discAmt) || 0 });
  const paid = detail.totals.paidTotal;
  const tooLow = paid > totals.grandTotal + 0.01;

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.put(`/order-changes/orders/${detail.id}/amend`, {
        ...(detail.kind === 'corporate' ? {} : { customerName: name.trim(), phone: phone.trim() }),
        lineItems: normalized,
        orderDiscountPct: Number(discPct) || 0,
        orderDiscountAmt: Number(discAmt) || 0,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not amend the order');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={`Amend order ${detail.orderNo}`}>
      <div className="dialog" style={{ maxWidth: 900 }}>
        <div className="dialog-title">Amend order {detail.orderNo}</div>
        <div className="dialog-body">
          {error && <p className="note" role="alert" style={{ color: 'var(--color-error)', fontWeight: 700 }}>{error}</p>}
          {detail.kind !== 'corporate' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <div className="field">
                <label>Customer name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
          )}
          <LineItemsEditor lineItems={lines} services={services} materials={materials} onChange={setLines} />
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Order discount %</label>
              <input className="input" style={{ maxWidth: 110 }} inputMode="decimal" value={discPct} onChange={(e) => setDiscPct(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>or amount</label>
              <input className="input" style={{ maxWidth: 130 }} inputMode="decimal" value={discAmt} onChange={(e) => setDiscAmt(e.target.value)} />
            </div>
          </div>
          <p style={{ marginBottom: 0 }}>
            Was <b>{fmtKsh(detail.totals.grandTotal)}</b> → now <b>{fmtKsh(totals.grandTotal)}</b>. Paid so far {fmtKsh(paid)}; balance after the change <b>{fmtKsh(Math.max(0, totals.grandTotal - paid))}</b>.
          </p>
          {tooLow && <p className="note" role="alert" style={{ color: 'var(--color-error)', fontWeight: 700 }}>The customer has paid more than this total. Refund or move the extra payment first.</p>}
          <p className="note">Stock is put back and taken again for the new lines. This can be done once for each approval.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || tooLow || normalized.length === 0}>Save the amended order</button>
        </div>
      </div>
    </div>
  );
}
