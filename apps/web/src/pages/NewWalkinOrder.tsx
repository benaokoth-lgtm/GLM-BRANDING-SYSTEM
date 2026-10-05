import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WALK_IN_CLIENT, computeOrderTotals, exceedsDiscountCeiling, fmtKsh, isNamedClient } from '@glm/shared';
import type { CompanySettings, DraftLineItem, OrderDetail } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import LineItemsEditor, { isBlankLine, makeDefaultLine } from '../components/LineItemsEditor';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { printOrderDocument } from '../utils/printInvoice';
import { costPayload } from '../utils/lineCosts';
import SourcingField from '../components/SourcingField';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from '../components/SplitPayments';
import type { PaymentRow } from '../components/SplitPayments';

export default function NewWalkinOrder() {
  const { services: allServices, materials, maxDiscountPct, loading } = useCatalog();
  // DTF Printing / DTF Sheet are sold exclusively through the DTF Sales &
  // Roll Tracker's own "Record sale"/"Record job" order popup (see
  // components/dtf/DtfOrderDialog.tsx) — not picked as a line item here.
  const services = allServices.filter((s) => !s.soldViaDtfModule);
  const { user } = useAuth();
  const navigate = useNavigate();

  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  // The order belongs to whoever is capturing it.
  const staffId = user?.id ?? null;
  // Ticked when the staff member brought this client in through their own network (credited to them for 12 months).
  const [sourced, setSourced] = useState(false);
  const [paymentTiming, setPaymentTiming] = useState<'onAcceptance' | 'onCompletion'>('onAcceptance');
  // Any mix of methods can pay the order now (e.g. part cash, part M-Pesa) — see components/SplitPayments.tsx.
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() => [newPaymentRow()]);
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [orderDiscountPct, setOrderDiscountPct] = useState('0');
  const [orderDiscountAmt, setOrderDiscountAmt] = useState('0');
  // The order-level discount is rarely used, so it stays out of the way until asked for.
  const [showOrderDiscount, setShowOrderDiscount] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = lineItems ?? (services.length && materials.length ? [makeDefaultLine(services, materials)] : []);

  // A line with nothing picked is left out.
  const normalized = items.filter((li) => !isBlankLine(li)).map((li) => ({
    itemType: li.itemType,
    serviceId: li.serviceId != null ? Number(li.serviceId) : null,
    materialId: li.materialId,
    qty: Number(li.qty) || 0,
    unitPrice: Number(li.unitPrice) || 0,
    discountPct: Number(li.discountPct) || 0,
    discountAmt: Number(li.discountAmt) || 0,
    heatPressFee: Number(li.heatPressFee) > 0 ? Number(li.heatPressFee) : undefined,
    artworkAreaSqm: Number(li.artworkAreaSqm) > 0 ? Number(li.artworkAreaSqm) : undefined,
    ...costPayload(li),
  }));
  const totals = computeOrderTotals({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 });
  const discountWarning = exceedsDiscountCeiling({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 }, maxDiscountPct);

  // The client's name and phone are optional (a blank name is recorded as "Walk-in") — except when the client is being credited to a
  // staff member for commission, which needs both to recognise them next time.
  const sourcingIncomplete = sourced && (!phone.trim() || !isNamedClient(customerName));

  const payProblem = paymentTiming === 'onAcceptance' ? paymentProblem(paymentRows, totals.grandTotal) : null;

  async function submit() {
    if (!staffId || payProblem || sourcingIncomplete || normalized.length === 0) return;
    setSubmitting(true);
    setError(null);
    // Open the popup synchronously (before any await) so browser popup
    // blockers don't treat it as unsolicited once we're past the API calls.
    const printWindow = window.open('', '_blank');
    try {
      const [order, company] = await Promise.all([
        api.post<OrderDetail>('/orders/walkin', {
          customerName: customerName.trim() || WALK_IN_CLIENT,
          phone,
          staffId,
          sourcedBy: sourced ? staffId : null,
          paymentTiming,
          payments: paymentTiming === 'onAcceptance' ? toApiPayments(paymentRows) : undefined,
          lineItems: normalized,
          orderDiscountPct: Number(orderDiscountPct) || 0,
          orderDiscountAmt: Number(orderDiscountAmt) || 0,
        }),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      printOrderDocument(printWindow, order, company); // walk-in orders print on the thermal receipt printer
      navigate('/orders/all');
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
          <label>Customer name (optional)</label>
          <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in (optional)" />
        </div>
        <div className="field">
          <label>Phone (optional)</label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" />
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

      <div style={{ marginTop: 'var(--space-3)' }}>
        <SourcingField phone={phone} name={customerName} staffName={user?.name ?? ''} checked={sourced} onChange={setSourced} />
      </div>

      <LineItemsEditor lineItems={items} services={services} materials={materials} onChange={setLineItems} />

      {showOrderDiscount || Number(orderDiscountPct) > 0 || Number(orderDiscountAmt) > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)', alignItems: 'end' }}>
          <div className="field">
            <label>Order discount %</label>
            <input className="input" value={orderDiscountPct} onChange={(e) => setOrderDiscountPct(e.target.value)} />
          </div>
          <div className="field">
            <label>Order discount Ksh</label>
            <input className="input" value={orderDiscountAmt} onChange={(e) => setOrderDiscountAmt(e.target.value)} />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setOrderDiscountPct('0');
              setOrderDiscountAmt('0');
              setShowOrderDiscount(false);
            }}
          >
            Remove discount
          </button>
          {discountWarning && <span className="tag tag-accent">Exceeds standard discount — needs supervisor approval</span>}
        </div>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-3)' }} onClick={() => setShowOrderDiscount(true)}>
          + Add order discount
        </button>
      )}

      {paymentTiming === 'onAcceptance' && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
            Payment now — split across cash, M-Pesa, bank or card if the customer likes
          </div>
          <SplitPayments rows={paymentRows} onChange={setPaymentRows} total={totals.grandTotal} phone={phone} accountReference={customerName || 'Walk-in order'} />
          {payProblem && (
            <p className="note" style={{ color: '#a33', marginTop: 'var(--space-2)' }}>
              {payProblem}
            </p>
          )}
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
        <button
          type="button"
          className="btn btn-primary blueprint"
          onClick={submit}
          disabled={submitting || !!payProblem || sourcingIncomplete || normalized.length === 0}
        >
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
