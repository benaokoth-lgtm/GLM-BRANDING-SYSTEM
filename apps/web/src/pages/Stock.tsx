import { Fragment, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { CatalogMaterial, PurchaseExpenseOption, PurchaseRow, RequisitionAwaitingPurchase, StockRequisitionRow, StockTakeRow } from '../api/models';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';

type StockTab = 'levels' | 'requisition' | 'approval' | 'purchases' | 'take';

const TABS: [StockTab, string][] = [
  ['levels', 'Stock Levels'],
  ['requisition', 'Stock Requisition'],
  ['approval', 'Stock Approval'],
  ['purchases', 'Purchases'],
  ['take', 'Stock Take'],
];

const STANDALONE = 'standalone';

export default function Stock() {
  const { user } = useAuth();
  const { materials, reload: reloadCatalog } = useCatalog();
  const [tab, setTab] = useState<StockTab>('levels');
  const [requisitions, setRequisitions] = useState<StockRequisitionRow[]>([]);
  const [stockTakes, setStockTakes] = useState<StockTakeRow[]>([]);
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [awaitingPurchase, setAwaitingPurchase] = useState<RequisitionAwaitingPurchase[]>([]);
  const [availableExpenses, setAvailableExpenses] = useState<PurchaseExpenseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canApprove = !!user && (user.role === 'Admin' || user.permissions.canApproveStock);

  const [newReq, setNewReq] = useState({ materialId: null as number | null, qty: '', note: '' });
  const [newTake, setNewTake] = useState({ materialId: null as number | null, countedQty: '', note: '', date: todayStr() });

  const [purchaseMode, setPurchaseMode] = useState<'new' | 'existing'>('new');
  const [newPurchase, setNewPurchase] = useState({
    requisitionKey: STANDALONE as string,
    materialId: null as number | null,
    supplier: '',
    qty: '',
    unitCost: '',
    invoiceNumber: '',
    expenseId: null as number | null,
    date: todayStr(),
  });
  const [rejectingPurchaseId, setRejectingPurchaseId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoading(true);
    Promise.all([
      api.get<StockRequisitionRow[]>('/stock/requisitions'),
      api.get<StockTakeRow[]>('/stock/takes'),
      api.get<PurchaseRow[]>('/stock/purchases'),
      api.get<RequisitionAwaitingPurchase[]>('/stock/requisitions/awaiting-purchase'),
      api.get<PurchaseExpenseOption[]>('/stock/available-expenses-for-purchase'),
    ])
      .then(([reqs, takes, pur, awaiting, expenses]) => {
        setRequisitions(reqs);
        setStockTakes(takes);
        setPurchases(pur);
        setAwaitingPurchase(awaiting);
        setAvailableExpenses(expenses);
        setNewPurchase((p) => ({ ...p, expenseId: p.expenseId ?? expenses[0]?.id ?? null }));
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
    if (newPurchase.materialId === null && materials.length > 0) {
      setNewPurchase((p) => ({ ...p, materialId: materials[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  function pickRequisitionForPurchase(key: string) {
    if (key === STANDALONE) {
      setNewPurchase((p) => ({ ...p, requisitionKey: key }));
      return;
    }
    const req = awaitingPurchase.find((r) => String(r.id) === key);
    setNewPurchase((p) => ({ ...p, requisitionKey: key, materialId: req?.materialId ?? p.materialId, qty: req ? String(req.qty) : p.qty }));
  }

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

  async function submitPurchase() {
    const qty = Number(newPurchase.qty);
    if (!newPurchase.materialId) return setError('Select a material');
    if (!qty || qty <= 0) return setError('Quantity must be greater than 0');
    setError(null);

    const requisitionId = newPurchase.requisitionKey === STANDALONE ? undefined : Number(newPurchase.requisitionKey);
    let payload: Record<string, unknown>;
    if (purchaseMode === 'new') {
      const unitCost = Number(newPurchase.unitCost);
      if (!unitCost || unitCost <= 0) return setError('Unit cost must be greater than 0');
      if (!newPurchase.invoiceNumber.trim()) return setError('Invoice/receipt number is required');
      payload = {
        mode: 'new',
        requisitionId,
        materialId: newPurchase.materialId,
        supplier: newPurchase.supplier,
        qty,
        unitCost,
        invoiceNumber: newPurchase.invoiceNumber,
        date: newPurchase.date,
      };
    } else {
      if (!newPurchase.expenseId) return setError('Select an already-logged purchase expense');
      payload = {
        mode: 'existing',
        requisitionId,
        materialId: newPurchase.materialId,
        supplier: newPurchase.supplier,
        qty,
        expenseId: newPurchase.expenseId,
        date: newPurchase.date,
      };
    }

    setBusy(true);
    try {
      await api.post('/stock/purchases', payload);
      setNewPurchase((p) => ({ ...p, requisitionKey: STANDALONE, supplier: '', qty: '', unitCost: '', invoiceNumber: '', expenseId: null }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture purchase');
    } finally {
      setBusy(false);
    }
  }

  async function acceptPurchase(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock/purchases/${id}/accept`, {});
      load();
      reloadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept purchase');
    } finally {
      setBusy(false);
    }
  }

  function startRejectPurchase(id: number) {
    setRejectingPurchaseId(id);
    setRejectReason('');
    setError(null);
  }

  async function submitRejectPurchase() {
    if (rejectingPurchaseId == null) return;
    if (!rejectReason.trim()) return setError('A reason for rejecting is required');
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock/purchases/${rejectingPurchaseId}/reject`, { reason: rejectReason });
      setRejectingPurchaseId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject purchase');
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
              Approving a requisition (under Stock Approval) only authorizes buying it — stock doesn't actually
              increase yet. A purchase still has to be captured against it under Purchases, then reconciled and
              accepted into the store before it's available for sale.
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

      {tab === 'purchases' && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Capture a purchase
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Recording a purchase here doesn't add to stock yet — it's held until a different finance
              manager/general manager/admin reconciles it (what was requisitioned vs. what was actually bought) and
              accepts it into the store under Purchase history below.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 0.8fr', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
              <div className="field">
                <label>Against requisition (optional)</label>
                <select className="input" value={newPurchase.requisitionKey} onChange={(e) => pickRequisitionForPurchase(e.target.value)}>
                  <option value={STANDALONE}>No requisition (standalone purchase)</option>
                  {awaitingPurchase.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.materialName} — qty {r.qty} — requested by {r.requestedByName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Material</label>
                <select
                  className="input"
                  value={newPurchase.materialId ?? ''}
                  disabled={newPurchase.requisitionKey !== STANDALONE}
                  onChange={(e) => setNewPurchase((p) => ({ ...p, materialId: Number(e.target.value) }))}
                >
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Supplier</label>
                <input className="input" value={newPurchase.supplier} onChange={(e) => setNewPurchase((p) => ({ ...p, supplier: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={newPurchase.date} onChange={(e) => setNewPurchase((p) => ({ ...p, date: e.target.value }))} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              <button type="button" className={'btn ' + (purchaseMode === 'new' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPurchaseMode('new')}>
                New purchase
              </button>
              <button type="button" className={'btn ' + (purchaseMode === 'existing' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPurchaseMode('existing')}>
                Already logged as an expense
              </button>
            </div>

            {purchaseMode === 'new' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
                <div className="field">
                  <label>Quantity purchased</label>
                  <input className="input" value={newPurchase.qty} onChange={(e) => setNewPurchase((p) => ({ ...p, qty: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Unit cost (Ksh)</label>
                  <input className="input" value={newPurchase.unitCost} onChange={(e) => setNewPurchase((p) => ({ ...p, unitCost: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Invoice/receipt #</label>
                  <input className="input" value={newPurchase.invoiceNumber} onChange={(e) => setNewPurchase((p) => ({ ...p, invoiceNumber: e.target.value }))} placeholder="Required" />
                </div>
                <button type="button" className="btn btn-primary blueprint" onClick={submitPurchase} disabled={busy}>
                  <i className="corner tl"></i>
                  <i className="corner tr"></i>
                  <i className="corner bl"></i>
                  <i className="corner br"></i>
                  Capture
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
                <div className="field">
                  <label>Quantity purchased</label>
                  <input className="input" value={newPurchase.qty} onChange={(e) => setNewPurchase((p) => ({ ...p, qty: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Purchase expense (Finance → Expenses)</label>
                  <select className="input" value={newPurchase.expenseId ?? ''} onChange={(e) => setNewPurchase((p) => ({ ...p, expenseId: Number(e.target.value) }))}>
                    {availableExpenses.length === 0 && <option value="">No unlinked purchase expenses</option>}
                    {availableExpenses.map((ex) => (
                      <option key={ex.id} value={ex.id}>
                        {fmtDate(ex.date)} — {ex.invoiceNumber} — {fmtKsh(ex.amount)}
                        {ex.note ? ` (${ex.note})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn btn-primary blueprint" onClick={submitPurchase} disabled={busy || availableExpenses.length === 0}>
                  <i className="corner tl"></i>
                  <i className="corner tr"></i>
                  <i className="corner bl"></i>
                  <i className="corner br"></i>
                  Capture
                </button>
              </div>
            )}
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Purchase history
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Material</th>
                    <th>Supplier</th>
                    <th style={{ textAlign: 'right' }}>Requisitioned</th>
                    <th style={{ textAlign: 'right' }}>Purchased</th>
                    <th style={{ textAlign: 'right' }}>Variance</th>
                    <th style={{ textAlign: 'right' }}>Total cost</th>
                    <th>Invoice #</th>
                    <th>Status</th>
                    <th>Captured by</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <Fragment key={p.id}>
                      <tr>
                        <td className="text-muted">{fmtDate(p.date)}</td>
                        <td>{p.materialName}</td>
                        <td className="text-muted">{p.supplier || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{p.requisitionedQty ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{p.qty}</td>
                        <td style={{ textAlign: 'right' }}>
                          {p.varianceQty == null ? (
                            '—'
                          ) : p.varianceQty === 0 ? (
                            <span className="tag tag-neutral">0</span>
                          ) : (
                            <span className={p.varianceQty < 0 ? 'tag tag-accent' : 'tag tag-neutral'}>{p.varianceQty > 0 ? `+${p.varianceQty}` : p.varianceQty}</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmtKsh(p.totalCost)}</td>
                        <td className="text-muted">{p.invoiceNumber || '—'}</td>
                        <td>
                          <span className={p.status === 'Accepted' ? 'tag tag-accent' : p.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{p.status}</span>
                        </td>
                        <td className="text-muted">{p.capturedByName}</td>
                        <td className="no-print">
                          {p.status === 'Held' && canApprove && p.capturedByName !== user?.name && (
                            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                              <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => acceptPurchase(p.id)} disabled={busy}>
                                Accept
                              </button>
                              <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => startRejectPurchase(p.id)} disabled={busy}>
                                Reject
                              </button>
                            </div>
                          )}
                          {p.status === 'Held' && p.capturedByName === user?.name && (
                            <span className="tag tag-outline" style={{ fontSize: 10 }}>
                              Awaiting another manager
                            </span>
                          )}
                        </td>
                      </tr>
                      {rejectingPurchaseId === p.id && (
                        <tr>
                          <td colSpan={11} style={{ background: 'var(--color-surface)' }}>
                            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                              <div className="field" style={{ margin: 0, flex: 1 }}>
                                <label>Reason for rejecting</label>
                                <input className="input" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Required" />
                              </div>
                              <button type="button" className="btn btn-primary" onClick={submitRejectPurchase} disabled={busy}>
                                Submit
                              </button>
                              <button type="button" className="btn btn-secondary" onClick={() => setRejectingPurchaseId(null)} disabled={busy}>
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {p.status === 'Rejected' && p.rejectReason && (
                        <tr>
                          <td colSpan={11} className="text-muted" style={{ fontSize: 11, paddingTop: 0 }}>
                            Rejected by {p.acceptedByName}: {p.rejectReason}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {purchases.length === 0 && <p className="note">No purchases captured yet.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              "Held" purchases haven't been added to stock yet — accepting one (by a different manager than whoever
              captured it) is what releases the quantity into Material stock on hand.
            </p>
          </div>
        </>
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
