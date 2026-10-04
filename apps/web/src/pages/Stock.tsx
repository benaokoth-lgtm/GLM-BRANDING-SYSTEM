import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { CatalogMaterial, StockRequisitionRow, StockTakeRow } from '../api/models';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';
import ImportCostCalculator from '../components/ImportCostCalculator';
import PurchasesTab from '../components/stock/PurchasesTab';
import ReconciliationTab from '../components/stock/ReconciliationTab';

type StockTab = 'levels' | 'requisition' | 'approval' | 'purchases' | 'reconciliation' | 'take' | 'imports';

const TABS: [StockTab, string][] = [
  ['levels', 'Stock Levels'],
  ['requisition', 'Purchases Requisition'],
  ['approval', 'Purchases Approval'],
  ['purchases', 'Purchases'],
  ['reconciliation', 'Purchases Reconciliation'],
  ['take', 'Stock Take'],
  ['imports', 'China Import Costing'],
];

interface ReqDraftLine {
  materialId: number | null;
  qty: string;
  est: string;
}
const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);

function Items({ r }: { r: StockRequisitionRow }) {
  return (
    <>
      {r.lines.map((l) => (
        <div key={l.id}>
          {l.materialName} × {l.qty}
          {l.estUnitCost != null && <span className="text-muted"> @ {l.estUnitCost} = {fmtKsh(l.qty * l.estUnitCost)}</span>}
        </div>
      ))}
    </>
  );
}
const reqTotal = (r: StockRequisitionRow) => r.lines.reduce((a, l) => a + (l.estUnitCost != null ? l.qty * l.estUnitCost : 0), 0);

export default function Stock() {
  const { user } = useAuth();
  const { materials, reload: reloadCatalog } = useCatalog();
  const [tab, setTab] = useState<StockTab>('levels');
  const [requisitions, setRequisitions] = useState<StockRequisitionRow[]>([]);
  const [stockTakes, setStockTakes] = useState<StockTakeRow[]>([]);
  const [lastCosts, setLastCosts] = useState<Record<number, number>>({});
  const [purchasesVersion, setPurchasesVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const canApprove = !!user && (user.role === 'Admin' || user.permissions.canApproveStock);

  // A requisition is a reference number (given when it is submitted) and any number of lines — each a material, a quantity and the
  // unit price expected, which the purchases reconciliation later compares the real price against.
  const [newReq, setNewReq] = useState<{ lines: ReqDraftLine[]; note: string }>({ lines: [{ materialId: null, qty: '', est: '' }], note: '' });
  const [newTake, setNewTake] = useState({ materialId: null as number | null, countedQty: '', note: '', date: todayStr() });

  function load() {
    setLoading(true);
    Promise.all([api.get<StockRequisitionRow[]>('/stock/requisitions'), api.get<StockTakeRow[]>('/stock/takes'), api.get<Record<number, number>>('/stock/material-costs')])
      .then(([reqs, takes, costs]) => {
        setRequisitions(reqs);
        setStockTakes(takes);
        setLastCosts(costs);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  useEffect(() => {
    if (newTake.materialId === null && materials.length > 0) {
      setNewTake((t) => ({ ...t, materialId: materials[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  const setReqLine = (i: number, patch: Partial<ReqDraftLine>) => setNewReq((r) => ({ ...r, lines: r.lines.map((x, n) => (n === i ? { ...x, ...patch } : x)) }));

  async function addRequisition() {
    // A blank expected price falls back to the last price paid for that material, when there is one.
    const lines = newReq.lines.map((l) => {
      const materialId = l.materialId ?? materials[0]?.id ?? null;
      const est = l.est.trim() !== '' ? num(l.est) : materialId != null ? lastCosts[materialId] ?? null : null;
      return { materialId, qty: num(l.qty), estUnitCost: est };
    });
    if (lines.some((l) => !l.materialId)) return setError('Choose a material for every line');
    if (lines.some((l) => !l.qty || l.qty <= 0)) return setError('Every line needs a quantity greater than 0');
    setError(null);
    setBusy(true);
    try {
      const created = await api.post<{ ref: string }>('/stock/requisitions', { lines, note: newReq.note });
      setNewReq({ lines: [{ materialId: null, qty: '', est: '' }], note: '' });
      setNotice(`Requisition ${created.ref} submitted`);
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
      setPurchasesVersion((v) => v + 1);
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
  const draftTotal = newReq.lines.reduce((a, l) => {
    const id = l.materialId ?? materials[0]?.id ?? null;
    const est = l.est.trim() !== '' ? num(l.est) : id != null ? lastCosts[id] ?? 0 : 0;
    return a + num(l.qty) * est;
  }, 0);

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
                  <td>{m.stockQty <= m.reorderLevel ? <span className="tag tag-accent">Reorder</span> : <span className="tag tag-neutral">OK</span>}</td>
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
              Purchases requisition
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Material</th>
                    <th style={{ width: 120 }}>Quantity</th>
                    <th style={{ width: 150 }}>Expected unit price</th>
                    <th style={{ width: 120, textAlign: 'right' }}>Expected total</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {newReq.lines.map((l, i) => {
                    const id = l.materialId ?? materials[0]?.id ?? null;
                    const last = id != null ? lastCosts[id] : undefined;
                    const est = l.est.trim() !== '' ? num(l.est) : last ?? 0;
                    return (
                      <tr key={i}>
                        <td>
                          <select className="input" value={id ?? ''} onChange={(e) => setReqLine(i, { materialId: Number(e.target.value), est: '' })}>
                            {materials.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({m.stockQty} on hand)
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input className="input" inputMode="decimal" value={l.qty} onChange={(e) => setReqLine(i, { qty: e.target.value })} placeholder="0" />
                        </td>
                        <td>
                          <input className="input" inputMode="decimal" value={l.est} onChange={(e) => setReqLine(i, { est: e.target.value })} placeholder={last != null ? `last paid ${last}` : 'Ksh'} />
                        </td>
                        <td style={{ textAlign: 'right' }}>{est > 0 ? fmtKsh(num(l.qty) * est) : '—'}</td>
                        <td>
                          {newReq.lines.length > 1 && (
                            <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this line" onClick={() => setNewReq((r) => ({ ...r, lines: r.lines.filter((_, n) => n !== i) }))}>
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 'var(--space-3)', alignItems: 'end', marginTop: 'var(--space-2)' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewReq((r) => ({ ...r, lines: [...r.lines, { materialId: null, qty: '', est: '' }] }))}>
                + Add another item
              </button>
              <div className="field" style={{ margin: 0 }}>
                <label>Note</label>
                <input className="input" value={newReq.note} onChange={(e) => setNewReq((r) => ({ ...r, note: e.target.value }))} placeholder="Optional — what it is for" />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={addRequisition} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Submit requisition
              </button>
            </div>
            {draftTotal > 0 && <p className="note" style={{ fontWeight: 700, marginBottom: 0 }}>Expected total: {fmtKsh(draftTotal)}</p>}
            {notice && <p className="note" style={{ fontWeight: 700 }}>{notice}</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              The expected unit price is what you expect to pay — leave it blank to use the last price paid. Approving a requisition (under Purchases Approval) only authorizes buying it: stock doesn’t
              increase yet. A purchase order is then captured against it under Purchases, received into the store by the store manager, and compared with the requisition under Purchases
              Reconciliation.
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
            Pending purchases requisitions
          </div>
          {!canApprove && (
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Only Finance Manager, General Manager and Admin can approve or reject requisitions.
            </p>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Requested</th>
                  <th>Items</th>
                  <th style={{ textAlign: 'right' }}>Expected total</th>
                  <th>Note</th>
                  <th>Requested by</th>
                  {canApprove && <th className="no-print"></th>}
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.ref}</strong>
                    </td>
                    <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
                    <td>
                      <Items r={r} />
                    </td>
                    <td style={{ textAlign: 'right' }}>{reqTotal(r) > 0 ? fmtKsh(reqTotal(r)) : '—'}</td>
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
          </div>
          {pending.length === 0 && <p className="note">No pending requisitions.</p>}
        </div>
      )}

      {tab === 'purchases' && <PurchasesTab materials={materials} reloadSignal={purchasesVersion} onStockChanged={reloadCatalog} />}

      {tab === 'reconciliation' && <ReconciliationTab />}

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
              The physical count immediately corrects the system quantity — any discrepancy (over or under) is logged below for audit rather than silently discarded.
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
                      {t.varianceQty === 0 ? '—' : <span className={t.varianceQty < 0 ? 'tag tag-accent' : 'tag tag-neutral'}>{t.varianceQty > 0 ? `+${t.varianceQty}` : t.varianceQty}</span>}
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

      {/* Always mounted (never conditionally rendered like the tabs above) so switching to another Stock tab to check something — e.g.
          Purchases, right after sending a shipment here — and back doesn't silently discard an in-progress shipment (mode, line
          items, settings). */}
      <div hidden={tab !== 'imports'}>
        <ImportCostCalculator
          onImported={() => {
            reloadCatalog();
            load();
            setPurchasesVersion((v) => v + 1);
          }}
        />
      </div>
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
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Requested</th>
              <th>Items</th>
              <th style={{ textAlign: 'right' }}>Expected total</th>
              <th>Note</th>
              <th>Requested by</th>
              <th>Status</th>
              <th>Decided by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.ref}</strong>
                </td>
                <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
                <td>
                  <Items r={r} />
                </td>
                <td style={{ textAlign: 'right' }}>{reqTotal(r) > 0 ? fmtKsh(reqTotal(r)) : '—'}</td>
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
      </div>
      {!loading && rows.length === 0 && <p className="note">No requisitions yet.</p>}
    </div>
  );
}
