import { useState } from 'react';
import { HEAT_PRESS_FEE_OPTIONS, PAYMENT_METHODS, fmtKsh, isNamedClient } from '@glm/shared';
import type { PaymentMethod } from '@glm/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../hooks/useCatalog';
import { printOrderDocument } from '../../utils/printInvoice';
import type { CompanySettings, OrderDetail } from '../../api/models';
import { Corners, Field } from './shared';
import SourcingField from '../SourcingField';
import { useAuth } from '../../state/AuthContext';
import SplitPayments, { newPaymentRow, paymentProblem, paymentsTotal, toApiPayments } from '../SplitPayments';
import type { PaymentRow } from '../SplitPayments';

interface MaterialLine {
  materialId: number;
  qty: string;
}

interface Props {
  mode: 'sale' | 'job';
  postUrl: '/dtf/sales' | '/dtf/jobs';
  basePayload: Record<string, unknown>;
  // qty × unitPrice is the film/artwork line's own total, before any
  // merchandise or (job-only) heat press fee is added on top.
  qty: number;
  unitPrice: number;
  client: string;
  /** A job priced below the recommended price: held for a manager's approval — no payment, no receipt yet. */
  needsApproval?: boolean;
  onClose: () => void;
  onDone: () => void;
}

// The "Record sale"/"Record job" popup — completes the order the calculator
// on the left already priced: optional merchandise sold alongside it,
// (artwork jobs only) a heat press fee, and how it's being paid. Pressing
// Print is what actually creates the order (and, server-side, the linked
// DtfFilmSale/DtfArtworkJob roll-consumption row) and prints two thermal
// receipts — nothing is saved before that.
export default function DtfOrderDialog({ mode, postUrl, basePayload, qty, unitPrice, client, needsApproval = false, onClose, onDone }: Props) {
  const { materials } = useCatalog();
  const { user } = useAuth();
  const [phone, setPhone] = useState('');
  const [sourced, setSourced] = useState(false);
  const [materialLines, setMaterialLines] = useState<MaterialLine[]>([]);
  const [heatPressFee, setHeatPressFee] = useState('');
  // Any mix of methods can pay now (e.g. part cash, part M-Pesa) — see components/SplitPayments.tsx.
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() => [newPaymentRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null); // order number, once it has been sent for approval

  const heatPress = mode === 'job' ? Number(heatPressFee) || 0 : 0;
  const serviceLineTotal = qty * (unitPrice + heatPress);
  const materialsTotal = materialLines.reduce((a, ml) => {
    const mt = materials.find((m) => m.id === ml.materialId);
    const q = Number(ml.qty) || 0;
    return a + (mt ? mt.price * q : 0);
  }, 0);
  const grandTotal = Math.round((serviceLineTotal + materialsTotal) * 100) / 100;
  const paid = paymentsTotal(paymentRows);
  const payProblem = needsApproval ? null : paymentProblem(paymentRows, grandTotal);
  // No artwork job is processed without the heat press fee.
  const heatPressMissing = mode === 'job' && !(heatPress > 0);
  // Name and phone are optional (a blank client is recorded as "Walk-in") — except when the client is credited to a staff member.
  const sourcingIncomplete = sourced && (!phone.trim() || !isNamedClient(client));

  function addMaterialLine() {
    const first = materials[0];
    if (!first) return;
    setMaterialLines((lines) => [...lines, { materialId: first.id, qty: '1' }]);
  }
  function updateMaterialLine(idx: number, patch: Partial<MaterialLine>) {
    setMaterialLines((lines) => lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function removeMaterialLine(idx: number) {
    setMaterialLines((lines) => lines.filter((_, i) => i !== idx));
  }

  async function print() {
    setBusy(true);
    setError(null);
    // The popup must open synchronously in this click handler, before any await, so popup blockers treat it as user-initiated.
    // (A walk-in receipt prints as two copies — the customer's and production's — in this one job.)
    const customerWin = needsApproval ? null : window.open('', '_blank');
    try {
      const payload = {
        ...basePayload,
        phone,
        sourcedBy: sourced && user ? user.id : null,
        payments: needsApproval ? [] : toApiPayments(paymentRows),
        materialLines: materialLines
          .filter((l) => Number(l.qty) > 0)
          .map((l) => ({ materialId: l.materialId, qty: Number(l.qty) })),
        ...(mode === 'job' ? { heatPressFee: heatPress } : {}),
      };
      const [{ order, approval }, company] = await Promise.all([
        api.post<{ order: OrderDetail; approval?: string | null }>(postUrl, payload),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      if (approval === 'Pending') {
        // Held for a manager's approval: nothing is printed or paid yet.
        setSentFor(order.orderNo);
        return;
      }
      printOrderDocument(customerWin, order, company);
      onDone();
    } catch (err) {
      customerWin?.close();
      setError(err instanceof Error ? err.message : `Failed to record ${mode === 'sale' ? 'sale' : 'job'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <Corners />
        <div className="dialog-title">Complete {mode === 'sale' ? 'film sale' : 'artwork job'} order</div>
        {sentFor ? (
          <>
            <div className="dialog-body">
              <p style={{ marginTop: 0 }}>
                <span className="tag tag-accent">Sent for approval</span> <b>{sentFor}</b>
              </p>
              <p className="note">
                The price is below the recommended price, so a manager has to approve it first. Payment is taken and production starts once it is approved — it shows in All Orders as “awaiting price
                approval”. If it is rejected the order is removed.
              </p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary blueprint" onClick={onDone}>
                <Corners />
                Done
              </button>
            </div>
          </>
        ) : (
          <>
        <div className="dialog-body">
        <p className="note" style={{ marginTop: 0 }}>
          {client ? `Client: ${client}` : 'Walk-in client'} — {mode === 'sale' ? 'film' : 'artwork'} line: {fmtKsh(serviceLineTotal)}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <Field label="Phone (optional)">
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" />
          </Field>

          <SourcingField phone={phone} name={client} staffName={user?.name ?? ''} checked={sourced} onChange={setSourced} />

          {mode === 'job' && (
            <Field label="Heat press fee (Ksh/pc) — required">
              <select className="input" value={heatPressFee} onChange={(e) => setHeatPressFee(e.target.value)} style={heatPressMissing ? { borderColor: '#a33' } : undefined}>
                <option value="">Select a fee…</option>
                {HEAT_PRESS_FEE_OPTIONS.map((fee) => (
                  <option key={fee} value={fee}>
                    Ksh {fee}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div>
            <label style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
              Merchandise sold with this {mode === 'sale' ? 'sale' : 'job'} (optional)
            </label>
            {materialLines.map((ml, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                <select className="input" value={ml.materialId} onChange={(e) => updateMaterialLine(idx, { materialId: Number(e.target.value) })}>
                  {materials.map((mt) => (
                    <option key={mt.id} value={mt.id}>
                      {mt.name} ({fmtKsh(mt.price)})
                    </option>
                  ))}
                </select>
                <input className="input" value={ml.qty} onChange={(e) => updateMaterialLine(idx, { qty: e.target.value })} placeholder="Qty" />
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => removeMaterialLine(idx)}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={addMaterialLine} disabled={materials.length === 0}>
              + Add merchandise item
            </button>
          </div>

          <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-heading)', fontSize: 18, marginBottom: 'var(--space-2)' }}>
              <span>Grand total</span>
              <span>{fmtKsh(grandTotal)}</span>
            </div>
            {needsApproval && (
              <p className="note" style={{ borderLeft: '2px solid #a33', paddingLeft: 'var(--space-2)' }}>
                This price is below the recommended price, so it goes to a manager for approval. <b>No payment is taken now</b> and no receipt is printed — payment and production follow once it is approved.
              </p>
            )}
            <div style={{ display: needsApproval ? 'none' : 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaymentRows([{ ...paymentRows[0]!, amount: String(grandTotal) }])}>
                Pay in full
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaymentRows([newPaymentRow()])}>
                Deposit / pay later
              </button>
            </div>
            {!needsApproval && <SplitPayments rows={paymentRows} onChange={setPaymentRows} total={grandTotal} phone={phone} accountReference={client || 'DTF order'} />}
            {payProblem && <p className="note" style={{ color: '#a33' }}>{payProblem}</p>}
          </div>

          {error && (
            <p className="note" style={{ color: '#a33' }}>
              {error}
            </p>
          )}
        </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary blueprint" onClick={onClose} disabled={busy}>
            <Corners />
            Cancel
          </button>
          <button type="button" className="btn btn-primary blueprint" onClick={print} disabled={busy || !!payProblem || sourcingIncomplete || heatPressMissing}>
            <Corners />
            {needsApproval ? 'Send for approval' : 'Print'}
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
