import { Fragment, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import type { BusinessHeadRow, CatalogMaterial, PurchaseExpenseOption, PurchaseRow, RequisitionAwaitingPurchase } from '../../api/models';
import { useAuth } from '../../state/AuthContext';

// Stock → Purchases. A purchase order (PO-0001…) has any number of lines — a material, the quantity bought and the real unit price from
// the supplier's invoice. It can be raised against an approved requisition, which pre-fills the lines. Stock does NOT go up when it is
// captured: the store manager receives it afterwards, entering what physically arrived on each line.

const STANDALONE = 'standalone';
type Mode = 'new' | 'existing';
interface Line {
  materialId: number | null;
  qty: string;
  unitCost: string;
  /** Business head: undefined = the material's usual head, '' = deliberately none, otherwise the head's id. */
  head?: string;
}
const blankLine = (): Line => ({ materialId: null, qty: '', unitCost: '' });
const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Card({ children, noPrint }: { children: React.ReactNode; noPrint?: boolean }) {
  return (
    <div className={'card blueprint' + (noPrint ? ' no-print' : '')} style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      {children}
    </div>
  );
}

export default function PurchasesTab({ materials, reloadSignal, onStockChanged }: { materials: CatalogMaterial[]; reloadSignal: number; onStockChanged: () => void }) {
  const { user } = useAuth();
  const canReceive = !!user && (user.role === 'Admin' || user.permissions.canReceiveStock || user.permissions.canApproveStock);

  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [awaiting, setAwaiting] = useState<RequisitionAwaitingPurchase[]>([]);
  const [expenses, setExpenses] = useState<PurchaseExpenseOption[]>([]);
  const [heads, setHeads] = useState<BusinessHeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<Mode>('new');
  const [form, setForm] = useState({ requisitionKey: STANDALONE, supplier: '', invoiceNumber: '', expenseId: null as number | null, date: todayStr() });
  const [lines, setLines] = useState<Line[]>([blankLine()]);

  const [receivingId, setReceivingId] = useState<number | null>(null);
  const [received, setReceived] = useState<Record<number, string>>({});
  const [receiveNote, setReceiveNote] = useState('');
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoading(true);
    Promise.all([
      api.get<PurchaseRow[]>('/stock/purchases'),
      api.get<RequisitionAwaitingPurchase[]>('/stock/requisitions/awaiting-purchase'),
      api.get<PurchaseExpenseOption[]>('/stock/available-expenses-for-purchase'),
      api.get<BusinessHeadRow[]>('/master-data/business-heads'),
    ])
      .then(([p, a, e, h]) => {
        setHeads(h);
        setPurchases(p);
        setAwaiting(a);
        setExpenses(e);
        setForm((f) => ({ ...f, expenseId: f.expenseId ?? e[0]?.id ?? null }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load purchases'))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [reloadSignal]);

  const requisition = awaiting.find((r) => String(r.id) === form.requisitionKey) ?? null;

  function pickRequisition(key: string) {
    setForm((f) => ({ ...f, requisitionKey: key }));
    const r = awaiting.find((x) => String(x.id) === key);
    // The remaining lines of the requisition become the lines of the purchase, at the expected price, ready to be corrected to the invoice.
    setLines(r ? r.lines.map((l) => ({ materialId: l.materialId, qty: String(l.qty), unitCost: l.estUnitCost != null ? String(l.estUnitCost) : '' })) : [blankLine()]);
  }

  const total = lines.reduce((a, l) => a + num(l.qty) * num(l.unitCost), 0);
  // What the requisition expected for the same materials, so the person capturing sees the variance before they save.
  const expected = requisition
    ? lines.reduce((a, l) => {
        const rl = requisition.lines.find((x) => x.materialId === l.materialId);
        return a + (rl && rl.estUnitCost != null ? rl.qty * rl.estUnitCost : 0);
      }, 0)
    : 0;
  const expectedKnown = !!requisition && requisition.lines.some((l) => l.estUnitCost != null);

  async function capture() {
    const payloadLines = lines.map((l) => ({
      materialId: l.materialId ?? materials[0]?.id ?? null,
      qty: num(l.qty),
      unitCost: num(l.unitCost),
      // left out = the material's usual business head; null = deliberately not tagged
      ...(l.head === undefined ? {} : { businessHeadId: l.head === '' ? null : Number(l.head) }),
    }));
    if (payloadLines.some((l) => !l.materialId)) return setError('Choose a material for every line');
    if (payloadLines.some((l) => l.qty <= 0)) return setError('Every line needs a quantity greater than 0');
    if (payloadLines.some((l) => l.unitCost <= 0)) return setError('Every line needs the unit price from the invoice');
    if (mode === 'new' && !form.invoiceNumber.trim()) return setError('Invoice/receipt number is required');
    if (mode === 'existing' && !form.expenseId) return setError('Select an already-logged purchase expense');
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const base = { requisitionId: requisition?.id, supplier: form.supplier, date: form.date, lines: payloadLines };
      const created = await api.post<PurchaseRow>('/stock/purchases', mode === 'new' ? { mode, invoiceNumber: form.invoiceNumber, ...base } : { mode, expenseId: form.expenseId, ...base });
      setNotice(`Purchase order ${created.poRef} captured — it is held until the store manager receives it`);
      setForm((f) => ({ ...f, requisitionKey: STANDALONE, supplier: '', invoiceNumber: '', expenseId: null }));
      setLines([blankLine()]);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to capture purchase');
    } finally {
      setBusy(false);
    }
  }

  function startReceive(p: PurchaseRow) {
    setReceivingId(p.id);
    setRejectingId(null);
    setReceived(Object.fromEntries(p.lines.map((l) => [l.id, String(l.qty)])));
    setReceiveNote('');
    setError(null);
  }

  async function receive(p: PurchaseRow) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock/purchases/${p.id}/accept`, {
        lines: p.lines.map((l) => ({ lineId: l.id, receivedQty: num(received[l.id] ?? '') })),
        note: receiveNote,
      });
      setReceivingId(null);
      setNotice(`${p.poRef} received into the store`);
      load();
      onStockChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to receive purchase');
    } finally {
      setBusy(false);
    }
  }

  async function reject(p: PurchaseRow) {
    if (!rejectReason.trim()) return setError('A reason for rejecting is required');
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock/purchases/${p.id}/reject`, { reason: rejectReason });
      setRejectingId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject purchase');
    } finally {
      setBusy(false);
    }
  }

  const usualHead = (materialId: number | null) => String(materials.find((m) => m.id === (materialId ?? materials[0]?.id))?.businessHeadId ?? '');
  const headOf = (l: Line) => (l.head === undefined ? usualHead(l.materialId) : l.head);

  async function retagLine(lineId: number, value: string) {
    setError(null);
    try {
      await api.patch(`/stock/purchases/lines/${lineId}/business-head`, { businessHeadId: value ? Number(value) : null });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to tag the line');
    }
  }

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  return (
    <>
      {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
      {notice && <p className="note" style={{ fontWeight: 700 }}>{notice}</p>}

      <Card noPrint>
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
          New purchase order
        </div>
        <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
          A purchase order has a reference (PO-0001…) given when you capture it, and as many items as the invoice has. It doesn’t add to stock yet — the store manager receives it and
          enters what physically arrived.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Against requisition (optional)</label>
            <select className="input" value={form.requisitionKey} onChange={(e) => pickRequisition(e.target.value)}>
              <option value={STANDALONE}>No requisition (standalone purchase)</option>
              {awaiting.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.ref} — {r.lines.length} item{r.lines.length === 1 ? '' : 's'} — by {r.requestedByName}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Supplier</label>
            <input className="input" value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} placeholder="Who supplied it" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Date</label>
            <input className="input" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Material</th>
                <th style={{ width: 110 }}>Qty bought</th>
                <th style={{ width: 130 }}>Unit price (Ksh)</th>
                <th style={{ width: 120, textAlign: 'right' }}>Line total</th>
                <th style={{ width: 170 }}>Business head</th>
                {requisition && <th style={{ width: 150 }}>Requisitioned</th>}
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const rl = requisition?.lines.find((x) => x.materialId === (l.materialId ?? materials[0]?.id));
                return (
                  <tr key={i}>
                    <td>
                      <select className="input" value={l.materialId ?? materials[0]?.id ?? ''} onChange={(e) => setLine(i, { materialId: Number(e.target.value) })}>
                        {materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="input" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} placeholder="0" />
                    </td>
                    <td>
                      <input className="input" inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} placeholder="0" />
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(num(l.qty) * num(l.unitCost))}</td>
                    <td>
                      <select className="input" value={headOf(l)} onChange={(e) => setLine(i, { head: e.target.value })}>
                        <option value="">Shared — not tagged</option>
                        {heads.filter((h) => h.active || String(h.id) === headOf(l)).map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {requisition && (
                      <td className="text-muted" style={{ fontSize: 12 }}>
                        {rl ? `${rl.qty}${rl.estUnitCost != null ? ` @ ${rl.estUnitCost}` : ''}` : <span className="tag tag-outline">not requisitioned</span>}
                      </td>
                    )}
                    <td>
                      {lines.length > 1 && (
                        <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this line" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            + Add another item
          </button>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>Total: {fmtKsh(total)}</div>
            {expectedKnown && (
              <div className="note" style={{ margin: 0 }}>
                Requisition expected {fmtKsh(expected)} for these items — {total - expected === 0 ? 'on budget' : <b style={{ color: total > expected ? 'var(--color-error)' : undefined }}>{total > expected ? 'over' : 'under'} by {fmtKsh(Math.abs(total - expected))}</b>}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', margin: 'var(--space-3) 0' }}>
          <button type="button" className={'btn ' + (mode === 'new' ? 'btn-primary' : 'btn-secondary')} onClick={() => setMode('new')}>
            New purchase (paid from petty cash)
          </button>
          <button type="button" className={'btn ' + (mode === 'existing' ? 'btn-primary' : 'btn-secondary')} onClick={() => setMode('existing')}>
            Already logged as an expense
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) auto', gap: 'var(--space-3)', alignItems: 'end' }}>
          {mode === 'new' ? (
            <div className="field" style={{ margin: 0 }}>
              <label>Invoice/receipt #</label>
              <input className="input" value={form.invoiceNumber} onChange={(e) => setForm((f) => ({ ...f, invoiceNumber: e.target.value }))} placeholder="Required" />
            </div>
          ) : (
            <div className="field" style={{ margin: 0 }}>
              <label>Purchase expense (Finance → Expenses) — the lines must add up to it</label>
              <select className="input" value={form.expenseId ?? ''} onChange={(e) => setForm((f) => ({ ...f, expenseId: Number(e.target.value) }))}>
                {expenses.length === 0 && <option value="">No unlinked purchase expenses</option>}
                {expenses.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {fmtDate(ex.date)} — {ex.invoiceNumber} — {fmtKsh(ex.amount)}
                    {ex.note ? ` (${ex.note})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="button" className="btn btn-primary blueprint" onClick={capture} disabled={busy || (mode === 'existing' && expenses.length === 0)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Capture purchase order
          </button>
        </div>
      </Card>

      <Card>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Purchase orders
        </div>
        {!canReceive && <p className="note">Receiving goods into the store is done by the store manager (or a Finance Manager, General Manager or Admin).</p>}
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>PO</th>
                <th>Date</th>
                <th>Supplier / invoice</th>
                <th>Items &amp; business head</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Status</th>
                <th>Captured by</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td>
                      <strong>{p.poRef}</strong>
                      {p.requisitionRef && <div className="note" style={{ margin: 0 }}>{p.requisitionRef}</div>}
                    </td>
                    <td className="text-muted">{fmtDate(p.date)}</td>
                    <td>
                      {p.supplier || '—'}
                      <div className="note" style={{ margin: 0 }}>{p.invoiceNumber || ''}</div>
                    </td>
                    <td>
                      {p.lines.map((l) => (
                        <div key={l.id} style={{ fontSize: 12 }}>
                          {l.materialName} × {l.qty} @ {l.unitCost}
                          {l.receivedQty != null && l.receivedQty !== l.qty && <b style={{ color: 'var(--color-error)' }}> — received {l.receivedQty}</b>}
                          {p.status !== 'Rejected' && (
                            <select className="input no-print" style={{ marginLeft: 6, width: 150, padding: '2px 4px', fontSize: 11 }} value={l.businessHeadId ?? ''} onChange={(e) => retagLine(l.id, e.target.value)} aria-label="Business head">
                              <option value="">— not tagged</option>
                              {heads.filter((h) => h.active || h.id === l.businessHeadId).map((h) => (
                                <option key={h.id} value={h.id}>
                                  {h.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(p.totalCost)}</td>
                    <td>
                      <span className={p.status === 'Accepted' ? 'tag tag-accent' : p.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{p.status === 'Accepted' ? 'Received' : p.status === 'Held' ? 'Awaiting receipt' : 'Rejected'}</span>
                    </td>
                    <td className="text-muted">{p.capturedByName}</td>
                    <td className="no-print">
                      {p.status === 'Held' && canReceive && p.capturedByName !== user?.name && (
                        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => startReceive(p)} disabled={busy}>
                            Receive
                          </button>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setRejectingId(p.id); setReceivingId(null); setRejectReason(''); setError(null); }} disabled={busy}>
                            Reject
                          </button>
                        </div>
                      )}
                      {p.status === 'Held' && p.capturedByName === user?.name && <span className="tag tag-outline" style={{ fontSize: 10 }}>Awaiting the store manager</span>}
                    </td>
                  </tr>
                  {receivingId === p.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--color-surface)' }}>
                        <div style={{ padding: 'var(--space-2) 0' }}>
                          <div className="card-kicker">Receive {p.poRef} into the store — enter what physically arrived</div>
                          <table className="table" style={{ maxWidth: 560 }}>
                            <thead>
                              <tr>
                                <th>Item</th>
                                <th style={{ textAlign: 'right' }}>Invoiced</th>
                                <th style={{ width: 130 }}>Received</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.lines.map((l) => {
                                const got = num(received[l.id] ?? '');
                                return (
                                  <tr key={l.id}>
                                    <td>
                                      {l.materialName}
                                      {l.requisitionedQty != null && <div className="note" style={{ margin: 0 }}>requisitioned {l.requisitionedQty}</div>}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>{l.qty}</td>
                                    <td>
                                      <input className="input" inputMode="decimal" value={received[l.id] ?? ''} onChange={(e) => setReceived((r) => ({ ...r, [l.id]: e.target.value }))} />
                                      {got !== l.qty && <div className="note" style={{ margin: 0, color: 'var(--color-error)' }}>{signed(got - l.qty)} against the invoice</div>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }}>
                            <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
                              <label>Note (optional)</label>
                              <input className="input" value={receiveNote} onChange={(e) => setReceiveNote(e.target.value)} placeholder="e.g. 8 caps short, damaged box" />
                            </div>
                            <button type="button" className="btn btn-primary" onClick={() => receive(p)} disabled={busy}>
                              Confirm receipt
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={() => setReceivingId(null)} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {rejectingId === p.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--color-surface)' }}>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                          <div className="field" style={{ margin: 0, flex: 1 }}>
                            <label>Reason for rejecting</label>
                            <input className="input" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Required" />
                          </div>
                          <button type="button" className="btn btn-primary" onClick={() => reject(p)} disabled={busy}>
                            Submit
                          </button>
                          <button type="button" className="btn btn-secondary" onClick={() => setRejectingId(null)} disabled={busy}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {p.status === 'Rejected' && p.rejectReason && (
                    <tr>
                      <td colSpan={8} className="text-muted" style={{ fontSize: 11, paddingTop: 0 }}>
                        Rejected by {p.acceptedByName}: {p.rejectReason}
                      </td>
                    </tr>
                  )}
                  {p.status === 'Accepted' && p.receiveNote && (
                    <tr>
                      <td colSpan={8} className="text-muted" style={{ fontSize: 11, paddingTop: 0 }}>
                        Received by {p.acceptedByName}: {p.receiveNote}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && purchases.length === 0 && <p className="note">No purchase orders captured yet.</p>}
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          Stock goes up only when the store manager receives a purchase order — by the quantity that physically arrived on each line, which may be less than was invoiced.
        </p>
      </Card>
    </>
  );
}
