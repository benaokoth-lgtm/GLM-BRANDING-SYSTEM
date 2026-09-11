import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeOrderTotals, exceedsDiscountCeiling, fmtKsh } from '@glm/shared';
import type { DraftLineItem } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import LineItemsEditor, { makeDefaultLine } from '../components/LineItemsEditor';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';

export default function NewQuotation() {
  const { services, materials, staff, corporateClients, maxDiscountPct, loading } = useCatalog();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [corporateClientId, setCorporateClientId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(user?.id ?? null);
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [orderDiscountPct, setOrderDiscountPct] = useState('0');
  const [orderDiscountAmt, setOrderDiscountAmt] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffOnly = staff.filter((s) => s.role === 'Staff');
  const effectiveClientId = corporateClientId ?? corporateClients[0]?.id ?? null;
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
    artworkAreaSqm: Number(li.artworkAreaSqm) > 0 ? Number(li.artworkAreaSqm) : undefined,
  }));
  const totals = computeOrderTotals({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 });
  const discountWarning = exceedsDiscountCeiling({ lineItems: normalized, orderDiscountPct: Number(orderDiscountPct) || 0, orderDiscountAmt: Number(orderDiscountAmt) || 0 }, maxDiscountPct);

  async function submit() {
    if (!effectiveClientId || !staffId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/orders/quote', {
        corporateClientId: effectiveClientId,
        staffId,
        lineItems: normalized,
        orderDiscountPct: Number(orderDiscountPct) || 0,
        orderDiscountAmt: Number(orderDiscountAmt) || 0,
      });
      navigate('/orders/mine');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save quotation');
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
      <div className="card-kicker">Corporate client</div>
      <div className="card-title">New Quotation</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div className="field">
          <label>Corporate client</label>
          <select className="input" value={effectiveClientId ?? ''} onChange={(e) => setCorporateClientId(Number(e.target.value))}>
            {corporateClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Prepared by</label>
          <select className="input" value={staffId ?? ''} onChange={(e) => setStaffId(Number(e.target.value))}>
            {staffOnly.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
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
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Quote total: {fmtKsh(totals.grandTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={submit} disabled={submitting || !effectiveClientId}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Save quotation
        </button>
      </div>
    </div>
  );
}
