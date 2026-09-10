import { useEffect, useState } from 'react';
import { FINANCE_ROLES, fmtDate } from '@glm/shared';
import { api } from '../api/client';
import type { CatalogMaterial, StockRequisitionRow } from '../api/models';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';

type StockTab = 'requisition' | 'approval';

const TABS: [StockTab, string][] = [
  ['requisition', 'Stock Requisition'],
  ['approval', 'Stock Approval'],
];

export default function Stock() {
  const { user } = useAuth();
  const { materials, reload: reloadCatalog } = useCatalog();
  const [tab, setTab] = useState<StockTab>('requisition');
  const [requisitions, setRequisitions] = useState<StockRequisitionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canApprove = !!user && FINANCE_ROLES.includes(user.role);

  const [newReq, setNewReq] = useState({ materialId: null as number | null, qty: '', note: '' });

  function load() {
    setLoading(true);
    api
      .get<StockRequisitionRow[]>('/stock/requisitions')
      .then(setRequisitions)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  useEffect(() => {
    if (newReq.materialId === null && materials.length > 0) {
      setNewReq((r) => ({ ...r, materialId: materials[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  async function addRequisition() {
    const qty = Number(newReq.qty);
    if (!newReq.materialId) return setError('Select a material');
    if (!qty || qty <= 0) return setError('Quantity must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/stock/requisitions', { materialId: newReq.materialId, qty, note: newReq.note });
      setNewReq((r) => ({ ...r, qty: '', note: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit requisition');
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: number, approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock/requisitions/${id}/${approve ? 'approve' : 'reject'}`, {});
      load();
      reloadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decide requisition');
    } finally {
      setBusy(false);
    }
  }

  const lowStock = materials.filter((m) => m.stockQty <= m.reorderLevel);
  const pending = requisitions.filter((r) => r.status === 'Pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={'btn blueprint ' + (tab === id ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab(id)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div className="card blueprint elev-sm" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">Reorder alerts</div>
        {lowStock.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>
            No materials at or below their reorder level.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
            {lowStock.map((m: CatalogMaterial) => (
              <span key={m.id} className="tag tag-accent">
                {m.name} — {m.stockQty} on hand (reorder at {m.reorderLevel})
              </span>
            ))}
          </div>
        )}
      </div>

      {tab === 'requisition' && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Request stock
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1.4fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Material</label>
                <select className="input" value={newReq.materialId ?? ''} onChange={(e) => setNewReq((r) => ({ ...r, materialId: Number(e.target.value) }))}>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.stockQty} on hand)
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Quantity</label>
                <input className="input" value={newReq.qty} onChange={(e) => setNewReq((r) => ({ ...r, qty: e.target.value }))} />
              </div>
              <div className="field">
                <label>Note</label>
                <input className="input" value={newReq.note} onChange={(e) => setNewReq((r) => ({ ...r, note: e.target.value }))} placeholder="Optional" />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={addRequisition} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Submit
              </button>
            </div>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Requested stock only becomes available for sale once a finance manager/general manager/admin approves it
              under Stock Approval.
            </p>
          </div>

          <RequisitionTable rows={requisitions} loading={loading} />
        </>
      )}

      {tab === 'approval' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
            Pending requisitions
          </div>
          {!canApprove && (
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Only Finance Manager, General Manager and Admin can approve or reject requisitions.
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Material</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th>Note</th>
                <th>Requested by</th>
                {canApprove && <th className="no-print"></th>}
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
                  <td>{r.materialName}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty}</td>
                  <td className="text-muted">{r.note}</td>
                  <td className="text-muted">{r.requestedByName}</td>
                  {canApprove && (
                    <td className="no-print">
                      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => decide(r.id, true)} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => decide(r.id, false)} disabled={busy}>
                          Reject
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {pending.length === 0 && <p className="note">No pending requisitions.</p>}
        </div>
      )}
    </div>
  );
}

function RequisitionTable({ rows, loading }: { rows: StockRequisitionRow[]; loading: boolean }) {
  return (
    <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
        Requisition history
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Requested</th>
            <th>Material</th>
            <th style={{ textAlign: 'right' }}>Qty</th>
            <th>Note</th>
            <th>Requested by</th>
            <th>Status</th>
            <th>Decided by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
              <td>{r.materialName}</td>
              <td style={{ textAlign: 'right' }}>{r.qty}</td>
              <td className="text-muted">{r.note}</td>
              <td className="text-muted">{r.requestedByName}</td>
              <td>
                <span className={r.status === 'Approved' ? 'tag tag-accent' : r.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{r.status}</span>
              </td>
              <td className="text-muted">{r.decidedByName || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && <p className="note">No requisitions yet.</p>}
    </div>
  );
}
