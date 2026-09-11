import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeOrderTotals, exceedsDiscountCeiling, fmtKsh } from '@glm/shared';
import type { CompanySettings, DraftLineItem, OrderDetail } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import LineItemsEditor, { makeDefaultLine } from '../components/LineItemsEditor';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { printWalkinReceipt } from '../utils/printTicket';

export default function NewWalkinOrder() {
  const { services, materials, staff, maxDiscountPct, loading } = useCatalog();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [staffId, setStaffId] = useState<number | null>(user?.id ?? null);
  const [paymentTiming, setPaymentTiming] = useState<'onAcceptance' | 'onCompletion'>('onAcceptance');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Card'>('Cash');
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [orderDiscountPct, setOrderDiscountPct] = useState('0');
  const [orderDiscountAmt, setOrderDiscountAmt] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffOnly = staff.filter((s) => s.role === 'Staff');
  const items = lineItems ?? (services.length && materials.length ? [makeDefaultLine(services, materials)] : []);

  const normalized = items.map((li) => ({
    itemType: li.itemType,
    serviceId: li.serviceId != null ? Number(li.serviceId) : null,
    materialId: li.materialId,
    qty: Number(li.qty) || 0,
    unitPrice: Number(li.unitPrice) || 0,
    discountPct: Number(li.discountPct) || 0,
    discountAmt: Number(li.discountAmt) || 0,
    filmLengthM: Number(li.filmLengthM) > 0 ? Number(li.filmLengthM) : undefined,
    heatPressFee: Number(li.heatPressFee) > 0 ? Number(li.heatPressFee) : undefined,
  }));
  const totals = computeOrderTotals({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 });
  const discountWarning = exceedsDiscountCeiling({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 }, maxDiscountPct);

  async function submit() {
    if (!customerName.trim() || !staffId) return;
    setSubmitting(true);
    setError(null);
    // Open the popup synchronously (before any await) so browser popup
    // blockers don't treat it as unsolicited once we're past the API calls.
    const printWindow = window.open('', '_blank');
    try {
      const [order, company] = await Promise.all([
        api.post<OrderDetail>('/orders/walkin', {
          customerName,
          phone,
          staffId,
          paymentTiming,
          paymentAmount: paymentTiming === 'onAcceptance' ? Number(paymentAmount) || 0 : undefined,
          paymentMethod: paymentTiming === 'onAcceptance' ? paymentMethod : undefined,
          lineItems: normalized,
          orderDiscountPct: Number(orderDiscountPct) || 0,
          orderDiscountAmt: Number(orderDiscountAmt) || 0,
        }),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      printWalkinReceipt(printWindow, order, company);
      navigate('/orders/mine');
    } catch (err) {
      printWindow?.close();
      setError(err instanceof Error ? err.message : 'Failed to capture order');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="note">Loading…</p>;

  return (
    <div className="card blueprint" style={{ maxWidth: 900 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Walk-in customer</div>
      <div className="card-title">New Order</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div className="field">
          <label>Customer name</label>
          <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. Peter Mwangi" />
        </div>
        <div className="field">
          <label>Phone</label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" />
        </div>
        <div className="field">
          <label>Allocate to staff</label>
          <select className="input" value={staffId ?? ''} onChange={(e) => setStaffId(Number(e.target.value))}>
            {staffOnly.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Payment timing</label>
          <div className="seg" role="radiogroup">
            <label className={'seg-opt' + (paymentTiming === 'onAcceptance' ? ' checked' : '')}>
              <input type="radio" name="wpay" checked={paymentTiming === 'onAcceptance'} onChange={() => setPaymentTiming('onAcceptance')} />
              Pay now
            </label>
            <label className={'seg-opt' + (paymentTiming === 'onCompletion' ? ' checked' : '')}>
              <input type="radio" name="wpay" checked={paymentTiming === 'onCompletion'} onChange={() => setPaymentTiming('onCompletion')} />
              Pay on completion
            </label>
          </div>
        </div>
      </div>

      <LineItemsEditor lineItems={items} services={services} materials={materials} onChange={setLineItems} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)', alignItems: 'end' }}>
        <div className="field">
          <label>Order discount %</label>
          <input className="input" value={orderDiscountPct} onChange={(e) => setOrderDiscountPct(e.target.value)} />
        </div>
        <div className="field">
          <label>Order discount Ksh</label>
          <input className="input" value={orderDiscountAmt} onChange={(e) => setOrderDiscountAmt(e.target.value)} />
        </div>
        {discountWarning && <span className="tag tag-accent">Exceeds standard discount — needs supervisor approval</span>}
      </div>

      {paymentTiming === 'onAcceptance' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
          <div className="field">
            <label>Amount received now (Ksh)</label>
            <input className="input" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="Full or partial" />
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
        </div>
      )}

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'var(--space-5)',
          borderTop: '1px solid var(--color-divider)',
          paddingTop: 'var(--space-4)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Grand total: {fmtKsh(totals.grandTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={submit} disabled={submitting || !customerName.trim()}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Capture order
        </button>
      </div>
    </div>
  );
}
