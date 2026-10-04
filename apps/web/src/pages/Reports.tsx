import { Fragment, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { AccountsReceivableData, EmbroideryProfitabilityData, OrderSummary, SalesByBusinessHeadData, SalesByCategoryData } from '../api/models';
import OrderDetailDialog from '../components/OrderDetailDialog';

type ReportTab = 'sales' | 'heads' | 'category' | 'embroidery' | 'ar';
type Preset = 'today' | 'month' | 'year' | 'custom';

const TABS: [ReportTab, string][] = [
  ['sales', 'Sales'],
  ['heads', 'Sales by Business Head'],
  ['category', 'Sales by Category'],
  ['embroidery', 'Embroidery Profitability'],
  ['ar', 'Accounts Receivable'],
];

const AR_BUCKET_LABELS: [keyof AccountsReceivableData['buckets'], string][] = [
  ['current', 'Not yet due'],
  ['days1to30', '1–30 days'],
  ['days31to60', '31–60 days'],
  ['days61to90', '61–90 days'],
  ['days90plus', '90+ days'],
];

function presetRange(preset: Preset, today: string, current: { from: string; to: string }): { from: string; to: string } {
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return current;
}

export default function Reports() {
  const today = todayStr();
  const [tab, setTab] = useState<ReportTab>('sales');
  const [preset, setPreset] = useState<Preset>('today');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);

  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [category, setCategory] = useState<SalesByCategoryData | null>(null);
  const [heads, setHeads] = useState<SalesByBusinessHeadData | null>(null);
  const [embroidery, setEmbroidery] = useState<EmbroideryProfitabilityData | null>(null);
  const [ar, setAr] = useState<AccountsReceivableData | null>(null);
  const [arDetailId, setArDetailId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p !== 'custom') {
      const r = presetRange(p, today, { from: fromDate, to: toDate });
      setFromDate(r.from);
      setToDate(r.to);
    }
  }

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<OrderSummary[]>('/orders'),
      api.get<SalesByCategoryData>(`/reports/sales-by-category?from=${fromDate}&to=${toDate}`),
      api.get<SalesByBusinessHeadData>(`/reports/sales-by-business-head?from=${fromDate}&to=${toDate}`),
      api.get<EmbroideryProfitabilityData>(`/reports/embroidery-profitability?from=${fromDate}&to=${toDate}`),
      api.get<AccountsReceivableData>('/reports/accounts-receivable'),
    ])
      .then(([o, c, h, e, a]) => {
        setOrders(o);
        setCategory(c);
        setHeads(h);
        setEmbroidery(e);
        setAr(a);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load reports'))
      .finally(() => setLoading(false));
  }

  useEffect(load, [fromDate, toDate]);

  if (loading && !orders) return <p className="note">Loading…</p>;

  const revenueOrders = (orders ?? []).filter((o) => (o.kind === 'walkin' || o.status === 'Invoice') && o.createdDate >= fromDate && o.createdDate <= toDate);
  const walkinTotal = revenueOrders.filter((o) => o.kind === 'walkin').reduce((a, o) => a + o.totals.grandTotal, 0);
  const corpTotal = revenueOrders.filter((o) => o.kind === 'corporate').reduce((a, o) => a + o.totals.grandTotal, 0);
  const salesTotal = walkinTotal + corpTotal;
  const cashCollected = (orders ?? []).reduce((a, o) => a + o.totals.paidTotal, 0);

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

      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className={'btn ' + (preset === 'today' ? 'btn-primary' : 'btn-secondary')} onClick={() => applyPreset('today')}>
              Daily (today)
            </button>
            <button type="button" className={'btn ' + (preset === 'month' ? 'btn-primary' : 'btn-secondary')} onClick={() => applyPreset('month')}>
              Monthly
            </button>
            <button type="button" className={'btn ' + (preset === 'year' ? 'btn-primary' : 'btn-secondary')} onClick={() => applyPreset('year')}>
              Yearly
            </button>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input
                className="input"
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setPreset('custom');
                  setFromDate(e.target.value);
                }}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input
                className="input"
                type="date"
                value={toDate}
                onChange={(e) => {
                  setPreset('custom');
                  setToDate(e.target.value);
                }}
              />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={() => window.print()}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Print / PDF
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      {tab === 'sales' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Walk-in sales</div>
              <div className="card-title">{fmtKsh(walkinTotal)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Corporate sales (invoiced)</div>
              <div className="card-title">{fmtKsh(corpTotal)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Total sales</div>
              <div className="card-title">{fmtKsh(salesTotal)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Orders in range</div>
              <div className="card-title">{revenueOrders.length}</div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Orders
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Order #</th>
                  <th>Kind</th>
                  <th>Customer</th>
                  <th>Staff</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {revenueOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="text-muted">{fmtDate(o.createdDate)}</td>
                    <td>{o.orderNo}</td>
                    <td>
                      <span className={o.kind === 'walkin' ? 'tag tag-accent' : 'tag tag-neutral'}>{o.kind === 'walkin' ? 'Walk-in' : 'Corporate'}</span>
                    </td>
                    <td className="text-muted">{o.customerName ?? o.corporateClient?.name ?? '—'}</td>
                    <td className="text-muted">{o.staff.name}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(o.totals.grandTotal)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(o.totals.paidTotal)}</td>
                    <td className="text-muted">{o.status}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontFamily: 'var(--font-heading)' }}>
                  <td colSpan={5} style={{ textAlign: 'right', paddingRight: 12 }}>
                    Total
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(salesTotal)}</td>
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            {revenueOrders.length === 0 && <p className="note">No sales in range.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Counts every walk-in order and invoiced corporate order dated in range (accrual basis), matching the
              P&amp;L and VAT reports. Cash actually collected across all periods to date: {fmtKsh(cashCollected)}.
            </p>
          </div>
        </>
      )}

      {tab === 'heads' && heads && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
            Sales, costs and margin by business head
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Business head</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Sales (excl. VAT)</th>
                  <th style={{ textAlign: 'right' }}>Purchases</th>
                  <th style={{ textAlign: 'right' }}>Other expenses</th>
                  <th style={{ textAlign: 'right' }}>Total costs</th>
                  <th style={{ textAlign: 'right' }}>Margin</th>
                  <th style={{ textAlign: 'right' }}>Margin %</th>
                </tr>
              </thead>
              <tbody>
                {heads.heads.map((h) => (
                  <Fragment key={h.name}>
                    <tr>
                      <td>
                        <strong>{h.name}</strong>
                        {!h.active && <span className="tag tag-neutral" style={{ marginLeft: 8 }}>not in use</span>}
                        <div className="note" style={{ margin: 0 }}>{h.sharePct.toFixed(1)}% of sales</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{h.orders}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(h.sales)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(h.costs.purchases)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(h.costs.expenses)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(h.costs.total)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: h.margin < 0 ? '#a33' : undefined }}>{fmtKsh(h.margin)}</td>
                      <td style={{ textAlign: 'right', color: h.margin < 0 ? '#a33' : undefined }}>{h.marginPct == null ? '—' : `${h.marginPct.toFixed(1)}%`}</td>
                    </tr>
                    {h.services.map((s) => (
                      <tr key={h.name + s.name}>
                        <td className="text-muted" style={{ paddingLeft: 'var(--space-5)', fontSize: 12 }}>{s.name} × {s.qty}</td>
                        <td></td>
                        <td className="text-muted" style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(s.sales)}</td>
                        <td colSpan={5}></td>
                      </tr>
                    ))}
                    {h.costs.expenseCategories.map((c) => (
                      <tr key={h.name + 'x' + c.category}>
                        <td className="text-muted" style={{ paddingLeft: 'var(--space-5)', fontSize: 12 }}>expense: {c.category}</td>
                        <td colSpan={3}></td>
                        <td className="text-muted" style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(c.amount)}</td>
                        <td colSpan={3}></td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                <tr>
                  <td>
                    <strong>Shared (not tagged to a head)</strong>
                    <div className="note" style={{ margin: 0 }}>costs nobody tagged — overheads such as rent, wages and utilities</div>
                  </td>
                  <td></td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(heads.unassignedCosts.purchases)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(heads.unassignedCosts.expenses)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(heads.unassignedCosts.total)}</td>
                  <td></td>
                  <td></td>
                </tr>
                {heads.unassignedCosts.expenseCategories.map((c) => (
                  <tr key={'u' + c.category}>
                    <td className="text-muted" style={{ paddingLeft: 'var(--space-5)', fontSize: 12 }}>expense: {c.category}</td>
                    <td colSpan={3}></td>
                    <td className="text-muted" style={{ textAlign: 'right', fontSize: 12 }}>{fmtKsh(c.amount)}</td>
                    <td colSpan={3}></td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}>
                  <td>Total</td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(heads.totalSales)}</td>
                  <td></td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(heads.totalCosts)}</td>
                  <td style={{ textAlign: 'right', color: heads.totalMargin < 0 ? '#a33' : undefined }}>{fmtKsh(heads.totalMargin)}</td>
                  <td style={{ textAlign: 'right' }}>{heads.totalSales > 0 ? `${((heads.totalMargin / heads.totalSales) * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Sales are raised in the period (orders and invoices, not quotations), after discounts and with the 16% VAT taken out, before credit notes. Costs are what was bought for each head
            (purchase orders, tagged line by line) plus the expenses tagged to it, as recorded — VAT included, since input VAT is not reclaimed. An expense that backs a purchase order is counted once,
            through the purchase. Tag a service, a material, a purchase line or an expense to a head to move its figures; whatever is untagged stays under Shared. Rejected purchases cost nothing.
          </p>
        </div>
      )}

      {tab === 'category' && category && (
        <>
          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Sales by service — which machines/services are performing
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {category.categories.map((c) => {
                  const grand = category.categories.reduce((a, x) => a + x.revenue, 0) + category.materials.revenue;
                  const share = grand > 0 ? (c.revenue / grand) * 100 : 0;
                  return (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td style={{ textAlign: 'right' }}>{c.qty}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(c.revenue)}</td>
                      <td style={{ textAlign: 'right' }}>{share.toFixed(1)}%</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="text-muted">Materials (products sold, not a service)</td>
                  <td style={{ textAlign: 'right' }} className="text-muted">
                    {category.materials.qty}
                  </td>
                  <td style={{ textAlign: 'right' }} className="text-muted">
                    {fmtKsh(category.materials.revenue)}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
            {category.categories.length === 0 && category.materials.revenue === 0 && <p className="note">No sales in range.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Ranked by revenue — the top rows are the services (embroidery, DTF printing, laser engraving, etc.)
              driving the most sales, useful for judging which machines/production lines are earning their keep.
            </p>
          </div>
        </>
      )}

      {tab === 'embroidery' && embroidery && (
        <>
          {!embroidery.serviceFound && (
            <p className="note">
              No "Embroidery" service found in Master Data → Service Price List — add one to enable this report.
            </p>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Embroidery revenue</div>
              <div className="card-title">{fmtKsh(embroidery.revenue)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Thread &amp; needle cost</div>
              <div className="card-title">{fmtKsh(embroidery.consumablesCost)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Gross profit</div>
              <div className="card-title">{fmtKsh(embroidery.grossProfit)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Gross margin</div>
              <div className="card-title">{embroidery.marginPct != null ? `${embroidery.marginPct.toFixed(1)}%` : '—'}</div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Per piece
              {embroidery.underpriced && <span className="tag tag-accent" style={{ marginLeft: 8 }}>Underpriced</span>}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'right' }}>Pieces sold</th>
                  <th style={{ textAlign: 'right' }}>Avg revenue/piece</th>
                  <th style={{ textAlign: 'right' }}>Avg consumable cost/piece</th>
                  <th style={{ textAlign: 'right' }}>Margin/piece</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ textAlign: 'right' }}>{embroidery.qtyPieces}</td>
                  <td style={{ textAlign: 'right' }}>{embroidery.avgRevenuePerPiece != null ? fmtKsh(embroidery.avgRevenuePerPiece) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{embroidery.avgCostPerPiece != null ? fmtKsh(embroidery.avgCostPerPiece) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{embroidery.marginPerPiece != null ? fmtKsh(embroidery.marginPerPiece) : '—'}</td>
                </tr>
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Consumable cost is spread evenly across pieces sold in range as a rough per-piece average — it isn't
              matched job-by-job (thread/needle usage isn't captured per order), so treat this as a gauge of whether
              Embroidery's price covers its consumables overall, not an exact per-job cost.
            </p>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Consumables bought in range
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {embroidery.consumableBreakdown.map((row) => (
                  <tr key={row.materialName}>
                    <td>{row.materialName}</td>
                    <td style={{ textAlign: 'right' }}>{row.qty}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(row.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {embroidery.consumableBreakdown.length === 0 && (
              <p className="note">
                No accepted thread/needle purchases in range — capture them under Stock → Purchases (Material:
                Embroidery Thread / Embroidery Needles) for this report to pick up their cost.
              </p>
            )}
          </div>
        </>
      )}

      {tab === 'ar' && ar && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-3)' }}>
            {AR_BUCKET_LABELS.map(([key, label]) => (
              <div key={key} className="card blueprint elev-sm">
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">{label}</div>
                <div className="card-title">{fmtKsh(ar.buckets[key])}</div>
              </div>
            ))}
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Outstanding invoices — total owed {fmtKsh(ar.totalOutstanding)} as of {fmtDate(ar.asOf)}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Type</th>
                  <th>Client</th>
                  <th>Staff</th>
                  <th>Due date</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th style={{ textAlign: 'right' }}>Balance due</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {ar.rows.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setArDetailId(r.id)}>
                    <td>{r.orderNo}</td>
                    <td>{r.kind === 'corporate' ? 'Corporate' : r.channel === 'dtf' ? 'Film/Artwork' : 'Walk-in'}</td>
                    <td className="text-muted">{r.client}</td>
                    <td className="text-muted">{r.staffName}</td>
                    <td className="text-muted">{fmtDate(r.dueDate)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.grandTotal)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.paidTotal)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(r.balanceDue)}</td>
                    <td>
                      {r.daysOverdue > 0 ? (
                        <span className="tag tag-accent">{r.daysOverdue}d overdue</span>
                      ) : (
                        <span className="tag tag-outline">Not yet due</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ar.rows.length === 0 && <p className="note">No outstanding invoices — everything's settled.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              Every order (corporate, walk-in, or Film/Artwork) currently sitting at "Invoice" with a balance still
              owed, aged off its due date. Click a row to record a payment against it directly.
            </p>
          </div>

          {arDetailId && (
            <OrderDetailDialog
              orderId={arDetailId}
              onClose={() => setArDetailId(null)}
              onChanged={load}
            />
          )}
        </>
      )}
    </div>
  );
}
