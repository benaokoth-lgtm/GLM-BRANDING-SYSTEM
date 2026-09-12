import { useState } from 'react';
import { computeOrderTotals, exceedsDiscountCeiling, fmtKsh } from '@glm/shared';
import type { DraftLineItem } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import LineItemsEditor, { makeDefaultLine } from '../components/LineItemsEditor';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';

interface Props {
  kind: 'quote' | 'invoice';
  onCreated: (orderNo: string) => void;
}

// Shared by the "Quotation" and "Invoice" tabs under Finance — same form
// either way (corporate client, line items, order discount); only the
// endpoint, title, and resulting order status differ. Creating an invoice
// directly is for a client who's already negotiated and agreed — skipping
// the quotation step entirely rather than raising a quote just to convert
// it moments later.
export default function CorporateOrderForm({ kind, onCreated }: Props) {
  const { services, materials, artworkSizeBands, staff, corporateClients, maxDiscountPct, loading } = useCatalog();
  const { user } = useAuth();

  const [corporateClientId, setCorporateClientId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(user?.id ?? null);
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [orderDiscountPct, setOrderDiscountPct] = useState('0');
  const [orderDiscountAmt, setOrderDiscountAmt] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whoever is actually preparing this (often a Finance Manager/GM
  // negotiating the deal directly, not just front-counter Staff) needs to
  // be selectable — not filtered down to Staff-role users only.
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
      const created = await api.post<{ orderNo: string }>(`/orders/${kind}`, {
        corporateClientId: effectiveClientId,
        staffId,
        lineItems: normalized,
        orderDiscountPct: Number(orderDiscountPct) || 0,
        orderDiscountAmt: Number(orderDiscountAmt) || 0,
      });
      setLineItems(null);
      setOrderDiscountPct('0');
      setOrderDiscountAmt('0');
      onCreated(created.orderNo);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save ${kind === 'quote' ? 'quotation' : 'invoice'}`);
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
      <div className="card-title">{kind === 'quote' ? 'New Quotation' : 'New Invoice'}</div>
      {kind === 'invoice' && (
        <p className="note" style={{ marginTop: 'var(--space-1)' }}>
          For a client who's already negotiated and agreed — no quotation step needed. This posts straight to
          Invoice, with the due date set from the client's credit terms.
        </p>
      )}

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
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <LineItemsEditor lineItems={items} services={services} materials={materials} artworkSizeBands={artworkSizeBands} onChange={setLineItems} />

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
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>{kind === 'quote' ? 'Quote total' : 'Invoice total'}: {fmtKsh(totals.grandTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={submit} disabled={submitting || !effectiveClientId}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          {kind === 'quote' ? 'Save quotation' : 'Create invoice'}
        </button>
      </div>
    </div>
  );
}
