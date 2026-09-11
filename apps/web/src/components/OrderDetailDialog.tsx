import { useEffect, useState } from 'react';
import { STAGES, fmtDate, fmtKsh } from '@glm/shared';
import type { OrderStage } from '@glm/shared';
import { api } from '../api/client';
import type { CompanySettings, OrderDetail } from '../api/models';
import { printWalkinReceipt } from '../utils/printTicket';
import { printCorporateDocument } from '../utils/printInvoice';

interface Props {
  orderId: number;
  onClose: () => void;
  onChanged: () => void;
}

export default function OrderDetailDialog({ orderId, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Card'>('Cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<OrderDetail>(`/orders/${orderId}`).then(setDetail).catch((err) => setError(err.message));
  }

  useEffect(load, [orderId]);

  async function recordPayment() {
    const amt = Number(paymentAmount);
    if (!amt || amt <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/payments`, { amount: amt, method: paymentMethod });
      setPaymentAmount('');
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  }

  async function setStage(stage: OrderStage) {
    setBusy(true);
    try {
      await api.patch(`/orders/${orderId}/stage`, { stage });
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    setBusy(true);
    try {
      await api.post(`/orders/${orderId}/convert`);
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    if (!detail) return;
    // Open the popup synchronously (no await before this) so browser popup
    // blockers don't treat it as an unsolicited window; fill it in once the
    // company profile (name/address/logo) has loaded.
    const w = window.open('', '_blank');
    const company = await api.get<CompanySettings>('/master-data/settings');
    if (detail.kind === 'walkin') {
      printWalkinReceipt(w, detail, company);
    } else {
      printCorporateDocument(w, detail, company);
    }
  }

  if (!detail) {
    return (
      <div className="dialog-backdrop">
        <div className="dialog blueprint">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <p className="note">Loading…</p>
        </div>
      </div>
    );
  }

  const clientLabel = detail.kind === 'corporate' ? detail.corporateClient?.name ?? '—' : detail.customerName ?? '—';

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog blueprint"
        style={{ maxWidth: 760, width: '92vw', maxHeight: '88vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">
          Order {detail.orderNo} <span className={detail.status === 'Quote' ? 'tag tag-outline' : 'tag tag-accent'}>{detail.status}</span>
        </div>
        <div className="dialog-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
            <div>
              <div className="card-kicker">Client</div>
              <div>{clientLabel}</div>
            </div>
            <div>
              <div className="card-kicker">Staff</div>
              <div>{detail.staff.name}</div>
            </div>
            <div>
              <div className="card-kicker">Created</div>
              <div>{fmtDate(detail.createdDate)}</div>
            </div>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th>Discount</th>
                <th>Line total</th>
              </tr>
            </thead>
            <tbody>
              {detail.lineItems.map((li) => (
                <tr key={li.id}>
                  <td>
                    {li.serviceName}
                    {li.materialName ? ` + ${li.materialName}` : ''}
                    {li.filmLengthM != null && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        Film used: {li.filmLengthM} m
                      </div>
                    )}
                    {li.heatPressFee != null && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        Heat press fee: {fmtKsh(li.heatPressFee)}/pc
                      </div>
                    )}
                  </td>
                  <td>{li.qty}</td>
                  <td>{fmtKsh(li.unitPrice)}</td>
                  <td>
                    {li.discountPct}% / {fmtKsh(li.discountAmt)}
                  </td>
                  <td>{fmtKsh(li.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-6)', margin: 'var(--space-3) 0', fontFamily: 'var(--font-heading)' }}>
            <div>Subtotal: {fmtKsh(detail.totals.subtotal)}</div>
            <div>Order discount: {fmtKsh(detail.totals.orderDiscount)}</div>
            <div>Grand total: {fmtKsh(detail.totals.grandTotal)}</div>
          </div>

          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              opacity: 0.55,
              margin: 'var(--space-4) 0 var(--space-2)',
            }}
          >
            Production stage
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {STAGES.map((st) => (
              <button
                key={st}
                type="button"
                className={'btn btn-sm ' + (detail.stage === st ? 'btn-primary' : 'btn-secondary')}
                onClick={() => setStage(st)}
                disabled={busy}
              >
                {st}
              </button>
            ))}
          </div>

          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              opacity: 0.55,
              margin: 'var(--space-4) 0 var(--space-2)',
            }}
          >
            Payments
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {detail.payments.map((p) => (
                <tr key={p.id}>
                  <td className="text-muted">{fmtDate(p.date)}</td>
                  <td>{fmtKsh(p.amount)}</td>
                  <td>{p.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.payments.length === 0 && <p className="note">No payments recorded yet.</p>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-3)' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>Balance due: {fmtKsh(detail.totals.balanceDue)}</div>
            {detail.overdue && <span className="tag tag-accent">Overdue — due {fmtDate(detail.dueDate)}</span>}
          </div>

          {error && (
            <p className="note" style={{ color: '#a33' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-3)', alignItems: 'end' }}>
            <div className="field">
              <label>Record payment (Ksh)</label>
              <input className="input" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
            </div>
            <div className="field">
              <label>Method</label>
              <select className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}>
                <option value="Cash">Cash</option>
                <option value="M-Pesa">M-Pesa</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Card">Card</option>
              </select>
            </div>
            <button type="button" className="btn btn-secondary blueprint" onClick={recordPayment} disabled={busy}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Record
            </button>
          </div>

          {detail.status === 'Quote' && (
            <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)' }}>
              <button type="button" className="btn btn-primary btn-block blueprint" onClick={convert} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Convert quotation to invoice
              </button>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary blueprint" onClick={print}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {detail.kind === 'walkin' ? '🖶 Print receipt' : detail.status === 'Quote' ? '🖶 Print quotation (A4)' : '🖶 Print invoice (A4)'}
          </button>
          <button type="button" className="btn btn-secondary blueprint" onClick={onClose}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
