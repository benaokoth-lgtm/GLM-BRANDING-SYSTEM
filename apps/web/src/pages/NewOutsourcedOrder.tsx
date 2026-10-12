import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WALK_IN_CLIENT, fmtKsh, isNamedClient, outsourcedCommission, outsourcedFigures } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { useSalesPeople } from '../hooks/useSalesPeople';
import { printOrderDocument } from '../utils/printInvoice';
import SourcingField from '../components/SourcingField';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from '../components/SplitPayments';
import type { PaymentRow } from '../components/SplitPayments';

// Outsourced Order — a contracted-out job the sales person buys from a supplier and sells on. For each item they enter what it is, how many, the unit SELLING price and the unit
// PURCHASING price (both VAT included), and see the gross margin as they go: sales without output VAT, less cost without claimable input VAT. Commission on these jobs is a share
// of that gross profit (Commission → Rates), earned as the customer pays.

interface CatalogService {
  id: number;
  name: string;
  unit: string;
  price: number;
  supplierName: string;
  defaultSupplierCost: number | null;
}
interface Catalog {
  vatRate: number;
  units: string[];
  services: CatalogService[];
  commission: { enabled: boolean; bands: { from: number; rate: number }[] };
}
interface Row {
  key: number;
  serviceId: string; // '' = nothing picked yet, 'custom' = typed in
  name: string; // for a typed item
  unit: string;
  qty: string;
  unitPrice: string;
  supplierCost: string;
  supplierName: string;
  vatClaimable: boolean;
}

let rowKey = 0;
const blankRow = (): Row => ({ key: ++rowKey, serviceId: '', name: '', unit: 'piece', qty: '1', unitPrice: '', supplierCost: '', supplierName: '', vatClaimable: true });
const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
const pct = (n: number | null) => (n == null ? '—' : `${parseFloat(n.toFixed(1))}%`);

export default function NewOutsourcedOrder() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Catalog>('/orders/outsourced/catalog').then(setCatalog).catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load the price list'));
  }, []);

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
  const [rows, setRows] = useState<Row[]>(() => [blankRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loadError) return <p className="note" style={{ color: 'var(--color-error)' }}>{loadError}</p>;
  if (!catalog) return <p className="note">Loading…</p>;
  const vat = catalog.vatRate;

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function pick(key: number, value: string) {
    if (value === '' || value === 'custom') return update(key, { serviceId: value, name: '', unitPrice: '', supplierCost: '', supplierName: '' });
    const sv = catalog!.services.find((s) => String(s.id) === value);
    // from the price list: its selling price, the supplier's saved price and name — all still editable for this job
    update(key, { serviceId: value, unit: sv?.unit ?? 'piece', unitPrice: sv ? String(sv.price) : '', supplierCost: sv?.defaultSupplierCost ? String(sv.defaultSupplierCost) : '', supplierName: sv?.supplierName ?? '' });
  }

  const filled = rows.filter((r) => r.serviceId !== '' && num(r.qty) > 0 && num(r.unitPrice) > 0);
  const lineFig = (r: Row) => outsourcedFigures(num(r.qty) * num(r.unitPrice), [{ qty: num(r.qty), unitCost: num(r.supplierCost), vatClaimable: r.vatClaimable }], vat);
  const total = outsourcedFigures(
    filled.reduce((a, r) => a + num(r.qty) * num(r.unitPrice), 0),
    filled.map((r) => ({ qty: num(r.qty), unitCost: num(r.supplierCost), vatClaimable: r.vatClaimable })),
    vat,
  );
  // The commission goes to the order's staff member: the person capturing it, or the sales person chosen when capturing for others.
  const creditedTo = forOthers && salesPersonId ? salesPeople.find((p) => p.id === salesPersonId)?.name ?? 'the sales person' : user?.name ?? 'you';
  const est = outsourcedCommission(total, catalog.commission.bands, 1);
  const grandTotal = total.saleIncl;

  const rowProblem = (r: Row): string | null => {
    if (r.serviceId === 'custom' && r.name.trim().length < 2) return 'Name the item';
    if (r.serviceId === '') return null;
    if (!(num(r.qty) > 0)) return 'Enter the quantity';
    if (!(num(r.unitPrice) > 0)) return 'Enter the unit selling price';
    if (r.supplierCost.trim() === '' || num(r.supplierCost) < 0) return 'Enter the unit purchasing price';
    if (num(r.unitPrice) < num(r.supplierCost)) return 'Selling below the purchasing price';
    return null;
  };
  const problem = rows.map(rowProblem).find(Boolean) ?? (filled.length === 0 ? 'Add at least one item' : null);
  const sourcingIncomplete = sourced && (!phone.trim() || !isNamedClient(customerName));
  const payProblem = paymentTiming === 'onAcceptance' ? paymentProblem(paymentRows, grandTotal) : null;

  async function submit() {
    if (!staffId || problem || payProblem || sourcingIncomplete) return;
    setSubmitting(true);
    setError(null);
    const printWindow = window.open('', '_blank');
    try {
      const [order, company] = await Promise.all([
        api.post<OrderDetail>('/orders/outsourced', {
          customerName: customerName.trim() || WALK_IN_CLIENT,
          phone,
          staffId: forOthers ? salesPersonId ?? staffId : staffId,
          sourcedBy: sourced ? (forOthers ? salesPersonId : staffId) : null,
          freelanceAgentId: freelanceId,
          paymentTiming,
          payments: paymentTiming === 'onAcceptance' ? toApiPayments(paymentRows) : undefined,
          lines: filled.map((r) => ({
            ...(r.serviceId === 'custom' ? { name: r.name.trim(), unit: r.unit } : { serviceId: Number(r.serviceId) }),
            qty: num(r.qty),
            unitPrice: num(r.unitPrice),
            supplierCost: num(r.supplierCost),
            supplierName: r.supplierName.trim() || undefined,
            supplierVatClaimable: r.vatClaimable,
          })),
        }),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      printOrderDocument(printWindow, order, company);
      navigate('/orders/all');
    } catch (err) {
      printWindow?.close();
      setError(err instanceof Error ? err.message : 'Failed to capture order');
    } finally {
      setSubmitting(false);
    }
  }

  const marginColor = (m: number | null) => (m == null ? undefined : m < 0 ? 'var(--color-error)' : m < 10 ? '#a8741a' : 'var(--color-accent)');

  return (
    <div className="card blueprint" style={{ maxWidth: 1000 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Contracted-out work</div>
      <div className="card-title">New Outsourced Order</div>
      <p className="note" style={{ marginTop: 0 }}>
        For jobs a supplier makes and you sell on. Enter what the supplier charges you and what you charge the customer, both with VAT included; the margin is worked out as you type. Only outsourced services can be captured here.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
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
              <input type="radio" name="opay" checked={paymentTiming === 'onAcceptance'} onChange={() => setPaymentTiming('onAcceptance')} />
              Pay now
            </label>
            <label className={'seg-opt' + (paymentTiming === 'onCompletion' ? ' checked' : '')}>
              <input type="radio" name="opay" checked={paymentTiming === 'onCompletion'} onChange={() => setPaymentTiming('onCompletion')} />
              Pay on completion
            </label>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <SourcingField phone={phone} name={customerName} staffName={user?.name ?? ''} checked={sourced} onChange={setSourced} freelanceId={freelanceId} onFreelanceChange={setFreelanceId} salesPeople={forOthers ? salesPeople : undefined} salesPersonId={salesPersonId} onSalesPersonChange={setSalesPersonId} />
      </div>

      <div className="card-kicker" style={{ marginTop: 'var(--space-5)' }}>Items</div>
      {rows.map((r) => {
        const f = lineFig(r);
        const prob = rowProblem(r);
        const picked = r.serviceId !== '';
        return (
          <div key={r.key} style={{ borderTop: '1px solid var(--color-divider)', padding: 'var(--space-3) 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) 0.7fr 1fr 1fr', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Item</label>
                <select className="input" value={r.serviceId} onChange={(e) => pick(r.key, e.target.value)}>
                  <option value="">Pick from the price list…</option>
                  {catalog.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  <option value="custom">— Not in the price list (type it) —</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Quantity{r.serviceId !== 'custom' && picked ? ` (${r.unit})` : ''}</label>
                <input className="input" inputMode="decimal" value={r.qty} onChange={(e) => update(r.key, { qty: e.target.value })} disabled={!picked} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Unit selling price</label>
                <input className="input" inputMode="decimal" value={r.unitPrice} onChange={(e) => update(r.key, { unitPrice: e.target.value })} placeholder="VAT incl." disabled={!picked} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Unit purchasing price</label>
                <input className="input" inputMode="decimal" value={r.supplierCost} onChange={(e) => update(r.key, { supplierCost: e.target.value })} placeholder="What the supplier charges, VAT incl." disabled={!picked} />
              </div>
            </div>
            {r.serviceId === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label>What is the item?</label>
                  <input className="input" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} placeholder="e.g. A3 gloss flyers" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>Unit</label>
                  <select className="input" value={r.unit} onChange={(e) => update(r.key, { unit: e.target.value })}>
                    {catalog.units.map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {picked && (
              <div style={{ display: 'flex', columnGap: 'var(--space-5)', rowGap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-2)' }}>
                <div className="field" style={{ margin: 0, minWidth: 200 }}>
                  <input className="input" value={r.supplierName} onChange={(e) => update(r.key, { supplierName: e.target.value })} placeholder="Supplier" aria-label="Supplier" />
                </div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }} title="A valid KRA tax invoice (eTIMS) from the supplier: the VAT in their price comes back as input VAT, so it is not a cost">
                  <input type="checkbox" checked={r.vatClaimable} onChange={(e) => update(r.key, { vatClaimable: e.target.checked })} />
                  Supplier gives a KRA tax invoice (VAT claimable)
                </label>
                <span className="note" style={{ margin: 0, flexBasis: '100%' }}>
                  Sale <b>{fmtKsh(f.saleIncl)}</b> · cost <b>{fmtKsh(f.costIncl)}</b> · gross profit <b style={{ color: marginColor(f.marginPct) }}>{fmtKsh(f.grossProfit)}</b> ({pct(f.marginPct)})
                </span>
                {rows.length > 1 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    Remove
                  </button>
                )}
              </div>
            )}
            {prob && picked && <p className="note" style={{ color: 'var(--color-error)', margin: 'var(--space-1) 0 0' }}>{prob}</p>}
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
        + Add item
      </button>

      <div className="card" style={{ marginTop: 'var(--space-5)', padding: 'var(--space-4)' }}>
        <div className="card-kicker">Gross margin on this job</div>
        <table className="table" style={{ maxWidth: 560, margin: 'var(--space-2) 0' }}>
          <tbody>
            <tr>
              <td>The customer pays (VAT included)</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(total.saleIncl)}</td>
            </tr>
            <tr>
              <td className="text-muted">less output VAT — owed to KRA, not income</td>
              <td style={{ textAlign: 'right' }}>({fmtKsh(total.outputVat)})</td>
            </tr>
            <tr style={{ fontWeight: 700 }}>
              <td>Net sales</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(total.netSales)}</td>
            </tr>
            <tr>
              <td>The supplier charges you (VAT included)</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(total.costIncl)}</td>
            </tr>
            <tr>
              <td className="text-muted">less input VAT you claim back</td>
              <td style={{ textAlign: 'right' }}>({fmtKsh(total.inputVatClaimed)})</td>
            </tr>
            <tr style={{ fontWeight: 700 }}>
              <td>Net cost{total.vatInCost > 0 ? ` (includes ${fmtKsh(total.vatInCost)} VAT you cannot claim)` : ''}</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(total.netCost)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>
              <td>Gross profit · margin</td>
              <td style={{ textAlign: 'right', color: marginColor(total.marginPct) }}>
                {fmtKsh(total.grossProfit)} · {pct(total.marginPct)}
              </td>
            </tr>
          </tfoot>
        </table>
        {catalog.commission.enabled && (
          <p className="note" style={{ margin: 0 }}>
            {total.grossProfit <= 0 ? (
              <>A job with no profit earns no commission.</>
            ) : est.ratePct === 0 ? (
              <>At a margin of {pct(total.marginPct)} this job earns <b>no commission</b> — the scale starts at {catalog.commission.bands.find((b) => b.rate > 0)?.from ?? 0}% margin.</>
            ) : (
              <>
                {forOthers ? `Commission for ${creditedTo}` : 'Your commission'} on this job: <b>{fmtKsh(est.full)}</b> — {est.ratePct}% of the gross profit, earned as the customer pays.
              </>
            )}
          </p>
        )}
      </div>

      {paymentTiming === 'onAcceptance' && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
            Payment now — split across cash, M-Pesa, bank or card if the customer likes
          </div>
          <SplitPayments rows={paymentRows} onChange={setPaymentRows} total={grandTotal} phone={phone} accountReference={customerName || 'Outsourced order'} />
          {payProblem && <p className="note" style={{ color: 'var(--color-error)', marginTop: 'var(--space-2)' }}>{payProblem}</p>}
        </div>
      )}

      {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-5)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-4)' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Grand total: {fmtKsh(grandTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={submit} disabled={submitting || !!problem || !!payProblem || sourcingIncomplete}>
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
