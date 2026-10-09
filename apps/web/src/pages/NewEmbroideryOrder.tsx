import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WALK_IN_CLIENT, fmtKsh, isNamedClient, quoteJob } from '@glm/shared';
import type { EmbroiderySettingsValues } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { printOrderDocument } from '../utils/printInvoice';
import { useSalesPeople } from '../hooks/useSalesPeople';
import SourcingField from '../components/SourcingField';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from '../components/SplitPayments';
import type { PaymentRow } from '../components/SplitPayments';

// Embroidery order: priced by stitch count (Master Data → Embroidery Pricing holds the rates). It is a General Order underneath — payments, receipts, invoices,
// the front office capturing for a sales person and commission all work as for the other orders. The setup (digitizing) fee and the design origination fee are
// their own lines on the order; the piece line carries the design name and its stitches. The server works the real price out; this screen previews it.

interface Config {
  settings: EmbroiderySettingsValues;
}
interface Saved {
  id: number;
  name: string;
  clientName: string;
  phone: string;
  stitches: number;
  timesUsed: number;
  lastUsedOn: string | null;
}
interface DesignRow {
  key: number;
  /** Set when the design was picked from the saved ones (a repeat: the saved stitch count, no setup fee). */
  designId?: number;
  name: string;
  stitches: string;
  /** Keep a new design for repeat orders. */
  save: boolean;
  /** Blank = the recommended price per piece. */
  price: string;
}

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;
let nextKey = 1;
const blankDesign = (): DesignRow => ({ key: nextKey++, name: '', stitches: '', save: true, price: '' });

export default function NewEmbroideryOrder() {
  const { materials, loading } = useCatalog();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const staffId = user?.id ?? null;
  const forOthers = user?.role === 'Admin' || !!user?.permissions.canCaptureForOthers;
  const salesPeople = useSalesPeople(forOthers);
  const [salesPersonId, setSalesPersonId] = useState<number | null>(null);
  const [sourced, setSourced] = useState(false);
  const [freelanceId, setFreelanceId] = useState<number | null>(null);
  const [paymentTiming, setPaymentTiming] = useState<'onAcceptance' | 'onCompletion'>('onAcceptance');
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() => [newPaymentRow()]);
  const [qty, setQty] = useState('12');
  const [clientSupplies, setClientSupplies] = useState(true);
  const [designs, setDesigns] = useState<DesignRow[]>(() => [blankDesign()]);
  const [garments, setGarments] = useState<{ key: number; materialId: number | ''; qty: string }[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedQ, setSavedQ] = useState('');
  const [saved, setSaved] = useState<Saved[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.get<Config>('/embroidery/config').then(setConfig).catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load the embroidery prices'));
  }, []);

  // the saved designs, searched as the person types
  useEffect(() => {
    if (!savedOpen) return;
    searchTimer.current = setTimeout(() => {
      api.get<Saved[]>(`/embroidery/designs?q=${encodeURIComponent(savedQ)}`).then(setSaved).catch(() => setSaved([]));
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [savedOpen, savedQ]);

  if (loadError) return <p className="note" style={{ color: 'var(--color-error)' }}>{loadError}</p>;
  if (!config || loading) return <p className="note">Loading…</p>;

  const { settings } = config;
  const pieces = Math.max(1, Math.round(num(qty)) || 1);
  const rows = designs.map((d) => ({ ...d, stitchesN: Math.round(num(d.stitches)), priceN: d.price.trim() === '' ? null : num(d.price) }));
  const quote = quoteJob(
    rows.map((d) => ({ name: d.name || 'Design', stitches: d.stitchesN, repeat: d.designId != null, pricePerPiece: d.priceN })),
    pieces,
    clientSupplies,
    settings,
  );
  const garmentRows = garments.map((g) => {
    const m = materials.find((x) => x.id === g.materialId);
    const q = num(g.qty);
    return { ...g, m, q, total: m ? m.price * q : 0 };
  });
  const garmentTotal = garmentRows.reduce((a, g) => a + g.total, 0);
  const grandTotal = quote.total + garmentTotal;

  const belowFor = (i: number) => rows[i]!.priceN != null && rows[i]!.priceN! < quote.designs[i]!.recommended - 0.005;
  const designsOk = rows.every((d) => d.name.trim() && d.stitchesN > 0);
  // A price below the recommended one is allowed, but the job then waits for a manager's approval and cannot be paid for or produced until it is given.
  const needsApproval = rows.some((_, i) => belowFor(i));
  const sourcingIncomplete = sourced && (!phone.trim() || !isNamedClient(customerName));
  const payNow = paymentTiming === 'onAcceptance' && !needsApproval;
  const payProblem = payNow ? paymentProblem(paymentRows, grandTotal) : null;
  const garmentsOk = garmentRows.every((g) => g.m && g.q > 0);
  const canSave = !!staffId && designsOk && garmentsOk && !payProblem && !sourcingIncomplete && !submitting;

  const setDesign = (key: number, patch: Partial<DesignRow>) => setDesigns((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  function useSavedDesign(s: Saved) {
    setDesigns((ds) => {
      const fresh: DesignRow = { key: nextKey++, designId: s.id, name: s.name, stitches: String(s.stitches), save: false, price: '' };
      // a still-empty first row is replaced by the saved design rather than left blank beside it
      return ds.length === 1 && !ds[0]!.name && !ds[0]!.stitches ? [fresh] : [...ds, fresh].slice(0, 6);
    });
    if (!customerName.trim() && s.clientName) setCustomerName(s.clientName);
    if (!phone.trim() && s.phone) setPhone(s.phone);
    setSavedOpen(false);
  }

  async function submit() {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    // Open the popup synchronously (before any await) so browser popup blockers don't treat it as unsolicited.
    const printWindow = window.open('', '_blank');
    try {
      const [order, company] = await Promise.all([
        api.post<OrderDetail>('/embroidery/orders', {
          customerName: customerName.trim() || WALK_IN_CLIENT,
          phone,
          staffId: forOthers ? salesPersonId ?? staffId : staffId,
          sourcedBy: sourced ? (forOthers ? salesPersonId : staffId) : null,
          freelanceAgentId: freelanceId,
          paymentTiming: needsApproval ? 'onCompletion' : paymentTiming,
          payments: payNow ? toApiPayments(paymentRows) : undefined,
          qty: pieces,
          clientSupplies,
          designs: rows.map((d) => ({
            designId: d.designId,
            name: d.name.trim(),
            stitches: d.stitchesN,
            repeat: d.designId != null,
            pricePerPiece: d.priceN != null && d.priceN > 0 ? d.priceN : null,
            save: d.designId == null && d.save,
          })),
          garments: garmentRows.map((g) => ({ materialId: g.m!.id, qty: g.q })),
        }),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      printOrderDocument(printWindow, order, company);
      navigate('/orders/all');
    } catch (err) {
      printWindow?.close();
      setError(err instanceof Error ? err.message : 'Failed to capture the order');
    } finally {
      setSubmitting(false);
    }
  }

  // the price ladder: the same designs at the usual quantities
  const ladder = [1, 6, 12, 25, 50, 100].map((q) => ({ q, quote: quoteJob(rows.map((d) => ({ name: d.name || 'Design', stitches: d.stitchesN, repeat: d.designId != null })), q, clientSupplies, settings) }));

  return (
    <div className="card blueprint" style={{ maxWidth: 960 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Embroidery order</div>
      <div className="card-title">New embroidery job</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div className="field">
          <label>{sourced ? 'Customer name *' : 'Customer name (optional)'}</label>
          <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in (optional)" style={sourced && !isNamedClient(customerName) ? { borderColor: 'var(--color-error)' } : undefined} />
        </div>
        <div className="field">
          <label>{sourced ? 'Phone *' : 'Phone (optional)'}</label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" style={sourced && !phone.trim() ? { borderColor: 'var(--color-error)' } : undefined} />
        </div>
        <div className="field">
          <label>Payment timing</label>
          <div className="seg" role="radiogroup">
            <label className={'seg-opt' + (paymentTiming === 'onAcceptance' ? ' checked' : '')}>
              <input type="radio" name="epay" checked={paymentTiming === 'onAcceptance'} onChange={() => setPaymentTiming('onAcceptance')} />
              Pay now
            </label>
            <label className={'seg-opt' + (paymentTiming === 'onCompletion' ? ' checked' : '')}>
              <input type="radio" name="epay" checked={paymentTiming === 'onCompletion'} onChange={() => setPaymentTiming('onCompletion')} />
              Pay on completion
            </label>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <SourcingField phone={phone} name={customerName} staffName={user?.name ?? ''} checked={sourced} onChange={setSourced} freelanceId={freelanceId} onFreelanceChange={setFreelanceId} salesPeople={forOthers ? salesPeople : undefined} salesPersonId={salesPersonId} onSalesPersonChange={setSalesPersonId} />
      </div>

      <div className="hr" />
      <div className="card-kicker">The job</div>
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 'var(--space-4)', alignItems: 'end', marginTop: 'var(--space-2)' }}>
        <div className="field">
          <label>Pieces (garments)</label>
          <input className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15 }}>
            <input type="checkbox" checked={clientSupplies} onChange={(e) => setClientSupplies(e.target.checked)} /> Client supplies the artwork / design
          </label>
          <p className="note" style={{ margin: '4px 0 0' }}>
            {clientSupplies ? 'Client artwork supplied — no design origination fee.' : `We create the artwork — ${fmtKsh(settings.originationFee)} design origination is added once to the job, on its own line.`}
          </p>
        </div>
      </div>

      <div className="card-kicker" style={{ marginTop: 'var(--space-4)' }}>
        Designs — one per placement (left chest, back …)
      </div>
      {designs.map((d, i) => {
        const q = quote.designs[i]!;
        const below = belowFor(i);
        return (
          <div key={d.key} className="blueprint" style={{ padding: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Design name</label>
                <input className="input" value={d.name} onChange={(e) => setDesign(d.key, { name: e.target.value })} placeholder="e.g. Left chest logo" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Stitches</label>
                <input className="input" inputMode="numeric" value={d.stitches} disabled={d.designId != null} title={d.designId != null ? 'A saved design keeps its stitch count' : undefined} onChange={(e) => setDesign(d.key, { stitches: e.target.value.replace(/\D/g, '') })} placeholder="6000" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Price per piece (blank = {fmtKsh(q.recommended)})</label>
                <input className="input" inputMode="decimal" value={d.price} onChange={(e) => setDesign(d.key, { price: e.target.value })} placeholder={String(q.recommended)} style={below ? { borderColor: 'var(--color-error)' } : undefined} />
              </div>
              {designs.length > 1 ? (
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this design" onClick={() => setDesigns((ds) => ds.filter((x) => x.key !== d.key))}>
                  ✕
                </button>
              ) : (
                <span />
              )}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-2)' }}>
              {d.designId != null ? (
                <span className="tag tag-accent">Saved design — repeat order, no setup fee</span>
              ) : (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={d.save} onChange={(e) => setDesign(d.key, { save: e.target.checked })} /> Keep this design for repeat orders
                </label>
              )}
              <span className="note" style={{ margin: 0 }}>
                {rows[i]!.stitchesN > 0 ? `${q.rate} per 1,000 stitches → ${fmtKsh(q.stitchCost)}${q.floored ? `, lifted to the ${fmtKsh(q.floor)} minimum` : ''}` : 'Enter the stitch count to price it'}
              </span>
            </div>
            {below && (
              <p className="note" style={{ color: 'var(--color-error)', margin: 'var(--space-2) 0 0' }}>
                Below the recommended {fmtKsh(q.recommended)} per piece — a manager has to approve this price before the job can be paid for or produced.
              </p>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={designs.length >= 6} onClick={() => setDesigns((ds) => [...ds, blankDesign()])}>
          + Add a design
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSavedOpen((o) => !o)}>
          {savedOpen ? 'Close saved designs' : 'Repeat order — pick a saved design'}
        </button>
      </div>
      {savedOpen && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <input className="input" autoFocus value={savedQ} onChange={(e) => setSavedQ(e.target.value)} placeholder="Search by design name, client or phone" />
          {saved.length === 0 ? (
            <p className="note">No saved designs{savedQ ? ' match that' : ' yet — tick “Keep this design for repeat orders” on a new design'}.</p>
          ) : (
            <table className="table" style={{ marginTop: 'var(--space-2)' }}>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b> <span className="text-muted">· {s.stitches.toLocaleString('en-KE')} stitches</span>
                    </td>
                    <td className="text-muted">{s.clientName || '—'}</td>
                    <td className="text-muted">{s.timesUsed}× used</td>
                    <td style={right}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => useSavedDesign(s)}>
                        Use
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card-kicker" style={{ marginTop: 'var(--space-4)' }}>
        Garments sold with the job (optional)
      </div>
      {garmentRows.map((g) => (
        <div key={g.key} style={{ display: 'grid', gridTemplateColumns: '2fr 100px 120px auto', gap: 'var(--space-3)', alignItems: 'end', marginTop: 'var(--space-2)' }}>
          <select className="input" value={g.materialId} onChange={(e) => setGarments((gs) => gs.map((x) => (x.key === g.key ? { ...x, materialId: e.target.value ? Number(e.target.value) : '' } : x)))}>
            <option value="">Choose a garment…</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {fmtKsh(m.price)}
              </option>
            ))}
          </select>
          <input className="input" inputMode="numeric" value={g.qty} onChange={(e) => setGarments((gs) => gs.map((x) => (x.key === g.key ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} aria-label="Quantity" />
          <div style={{ ...right, paddingBottom: 8 }}>{g.m ? fmtKsh(g.total) : '—'}</div>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this garment" onClick={() => setGarments((gs) => gs.filter((x) => x.key !== g.key))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-2)' }} onClick={() => setGarments((gs) => [...gs, { key: nextKey++, materialId: '', qty: String(pieces) }])}>
        + Add a garment
      </button>

      <div className="hr" />
      <div className="card-kicker">What goes on the order</div>
      <table className="table" style={{ marginTop: 'var(--space-2)' }}>
        <thead>
          <tr>
            <th>Line</th>
            <th style={right}>Qty</th>
            <th style={right}>Price</th>
            <th style={right}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((d, i) => {
            const q = quote.designs[i]!;
            const out = [
              <tr key={`p${d.key}`}>
                <td>
                  Embroidery per piece — {d.name || 'Design'} · {d.stitchesN.toLocaleString('en-KE')} stitches
                </td>
                <td style={right}>{pieces}</td>
                <td style={right}>{fmtKsh(q.piece)}</td>
                <td style={right}>{fmtKsh(q.pieces)}</td>
              </tr>,
            ];
            if (q.setup > 0)
              out.push(
                <tr key={`s${d.key}`}>
                  <td>Embroidery digitizing setup — {d.name || 'Design'}</td>
                  <td style={right}>1</td>
                  <td style={right}>{fmtKsh(q.setup)}</td>
                  <td style={right}>{fmtKsh(q.setup)}</td>
                </tr>,
              );
            return out;
          })}
          {quote.origination > 0 && (
            <tr>
              <td>Design origination</td>
              <td style={right}>1</td>
              <td style={right}>{fmtKsh(quote.origination)}</td>
              <td style={right}>{fmtKsh(quote.origination)}</td>
            </tr>
          )}
          {garmentRows.filter((g) => g.m).map((g) => (
            <tr key={`g${g.key}`}>
              <td>{g.m!.name}</td>
              <td style={right}>{g.q}</td>
              <td style={right}>{fmtKsh(g.m!.price)}</td>
              <td style={right}>{fmtKsh(g.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((d) => d.designId == null) && settings.waiveAtQty > 0 && pieces < settings.waiveAtQty && (
        <p className="note">The setup fee is waived from {settings.waiveAtQty} pieces, and on a repeat of a saved design.</p>
      )}

      <details style={{ marginTop: 'var(--space-3)' }}>
        <summary style={{ cursor: 'pointer' }} className="note">
          Price ladder — the same {designs.length > 1 ? 'designs' : 'design'} at other quantities
        </summary>
        <table className="table" style={{ marginTop: 'var(--space-2)' }}>
          <thead>
            <tr>
              <th>Pieces</th>
              <th style={right}>Per piece</th>
              <th style={right}>Order total</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((l) => (
              <tr key={l.q}>
                <td>{l.q}</td>
                <td style={right}>{l.quote.designs.map((d) => fmtKsh(d.piece)).join(' + ')}</td>
                <td style={right}>
                  <b>{fmtKsh(l.quote.total)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">Totals include setup and, if it applies, design origination.</p>
      </details>

      {needsApproval && (
        <p className="note" style={{ marginTop: 'var(--space-4)', borderLeft: '2px solid var(--color-error)', paddingLeft: 'var(--space-2)' }}>
          <b>Waiting for approval.</b> This job goes to the price-approval queue (DTF → Approvals) when you capture it. Payment is taken once a manager approves the price — it cannot be paid for or produced until then, and the person who captured it cannot approve it.
        </p>
      )}
      {payNow && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
            Payment now — split across cash, M-Pesa, bank or card if the customer likes
          </div>
          <SplitPayments rows={paymentRows} onChange={setPaymentRows} total={grandTotal} phone={phone} accountReference={customerName || 'Embroidery order'} />
          {payProblem && (
            <p className="note" style={{ color: 'var(--color-error)', marginTop: 'var(--space-2)' }}>
              {payProblem}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="note" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-5)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-4)' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Grand total: {fmtKsh(grandTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={submit} disabled={!canSave}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          {needsApproval ? 'Capture and send for approval' : 'Capture order'}
        </button>
      </div>
    </div>
  );
}
