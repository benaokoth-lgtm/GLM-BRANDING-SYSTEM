import { useEffect, useState } from 'react';
import { fmtDate, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { CatalogMaterial, StockRequisitionRow, StockTakeRow } from '../api/models';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';

type StockTab = 'levels' | 'requisition' | 'approval' | 'take';

const TABS: [StockTab, string][] = [
  ['levels', 'Stock Levels'],
  ['requisition', 'Stock Requisition'],
  ['approval', 'Stock Approval'],
  ['take', 'Stock Take'],
];

export default function Stock() {
  const { user } = useAuth();
  const { materials, reload: reloadCatalog } = useCatalog();
  const [tab, setTab] = useState<StockTab>('levels');
  const [requisitions, setRequisitions] = useState<StockRequisitionRow[]>([]);
  const [stockTakes, setStockTakes] = useState<StockTakeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canApprove = !!user && (user.role === 'Admin' || user.permissions.canApproveStock);

  const [newReq, setNewReq] = useState({ materialId: null as number | null, qty: '', note: '' });
  const [newTake, setNewTake] = useState({ materialId: null as number | null, countedQty: '', note: '', date: todayStr() });

  function load() {
    setLoading(true);
    Promise.all([api.get<StockRequisitionRow[]>('/stock/requisitions'), api.get<StockTakeRow[]>('/stock/takes')])
      .then(([reqs, takes]) => {
        setRequisitions(reqs);
        setStockTakes(takes);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  useEffect(() => {
    if (newReq.materialId === null && materials.length > 0) {
      setNewReq((r) => ({ ...r, materialId: materials[0].id }));
    }
    if (newTake.materialId === null && materials.length > 0) {
      setNewTake((t) => ({ ...t, materialId: materials[0].id }));
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

  async function submitStockTake() {
    const countedQty = Number(newTake.countedQty);
    if (!newTake.materialId) return setError('Select a material');
    if (newTake.countedQty === '' || countedQty < 0) return setError('Counted quantity must be 0 or more');
    setError(null);
    setBusy(true);
    try {
      await api.post('/stock/takes', { materialId: newTake.materialId, countedQty, note: newTake.note, date: newTake.date });
      setNewTake((t) => ({ ...t, countedQty: '', note: '' }));
      load();
      reloadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit stock take');
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

      {tab === 'levels' && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
            Materials in stock
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Material</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'right' }}>On hand</th>
                <th style={{ textAlign: 'right' }}>Reorder level</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td style={{ textAlign: 'right' }}>{m.price}</td>
                  <td style={{ textAlign: 'right' }}>{m.stockQty}</td>
                  <td style={{ textAlign: 'right' }}>{m.reorderLevel}</td>
                  <td>
                    {m.stockQty <= m.reorderLevel ? (
                      <span className="tag tag-accent">Reorder</span>
                    ) : (
                      <span className="tag tag-neutral">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {materials.length === 0 && <p className="note">No materials in Master Data yet.</p>}
        </div>
      )}

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

      {tab === 'take' && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Record a physical count
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1.4fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Material</label>
                <select className="input" value={newTake.materialId ?? ''} onChange={(e) => setNewTake((t) => ({ ...t, materialId: Number(e.target.value) }))}>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} (system: {m.stockQty})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Counted qty</label>
                <input className="input" value={newTake.countedQty} onChange={(e) => setNewTake((t) => ({ ...t, countedQty: e.target.value }))} />
              </div>
              <div className="field">
                <label>Note</label>
                <input className="input" value={newTake.note} onChange={(e) => setNewTake((t) => ({ ...t, note: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={newTake.date} onChange={(e) => setNewTake((t) => ({ ...t, date: e.target.value }))} />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={submitStockTake} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Submit
              </button>
            </div>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              The physical count immediately corrects the system quantity — any discrepancy (over or under) is logged
              below for audit rather than silently discarded.
            </p>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Stock take history
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Material</th>
                  <th style={{ textAlign: 'right' }}>System qty</th>
                  <th style={{ textAlign: 'right' }}>Counted qty</th>
                  <th style={{ textAlign: 'right' }}>Variance</th>
                  <th>Note</th>
                  <th>Counted by</th>
                </tr>
              </thead>
              <tbody>
                {stockTakes.map((t) => (
                  <tr key={t.id}>
                    <td className="text-muted">{fmtDate(t.date)}</td>
                    <td>{t.materialName}</td>
                    <td style={{ textAlign: 'right' }}>{t.systemQty}</td>
                    <td style={{ textAlign: 'right' }}>{t.countedQty}</td>
                    <td style={{ textAlign: 'right' }}>
                      {t.varianceQty === 0 ? (
                        '—'
                      ) : (
                        <span className={t.varianceQty < 0 ? 'tag tag-accent' : 'tag tag-neutral'}>{t.varianceQty > 0 ? `+${t.varianceQty}` : t.varianceQty}</span>
                      )}
                    </td>
                    <td className="text-muted">{t.note}</td>
                    <td className="text-muted">{t.countedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stockTakes.length === 0 && <p className="note">No stock takes recorded yet.</p>}
          </div>
        </>
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
