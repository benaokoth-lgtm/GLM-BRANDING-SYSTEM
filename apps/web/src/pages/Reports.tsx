import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { EmbroideryProfitabilityData, FilmUsageRow, OrderSummary, SalesByCategoryData } from '../api/models';

type ReportTab = 'sales' | 'filmusage' | 'category' | 'embroidery';
type Preset = 'today' | 'month' | 'year' | 'custom';

const TABS: [ReportTab, string][] = [
  ['sales', 'Sales'],
  ['filmusage', 'Film Usage'],
  ['category', 'Sales by Category'],
  ['embroidery', 'Embroidery Profitability'],
];

function presetRange(preset: Preset, today: string, current: { from: string; to: string }): { from: string; to: string } {
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return current;
}

function fmtM(n: number): string {
  return `${(Math.round(n * 10) / 10).toLocaleString('en-KE')} m`;
}

export default function Reports() {
  const today = todayStr();
  const [tab, setTab] = useState<ReportTab>('sales');
  const [preset, setPreset] = useState<Preset>('today');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);

  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [usages, setUsages] = useState<FilmUsageRow[] | null>(null);
  const [category, setCategory] = useState<SalesByCategoryData | null>(null);
  const [embroidery, setEmbroidery] = useState<EmbroideryProfitabilityData | null>(null);
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
      api.get<FilmUsageRow[]>(`/film/usage?from=${fromDate}&to=${toDate}`),
      api.get<SalesByCategoryData>(`/reports/sales-by-category?from=${fromDate}&to=${toDate}`),
      api.get<EmbroideryProfitabilityData>(`/reports/embroidery-profitability?from=${fromDate}&to=${toDate}`),
    ])
      .then(([o, u, c, e]) => {
        setOrders(o);
        setUsages(u);
        setCategory(c);
        setEmbroidery(e);
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

  const usedM = (usages ?? []).reduce((a, u) => a + u.lengthM, 0);
  const filmRevenue = (usages ?? []).reduce((a, u) => a + (u.revenue ?? 0), 0);

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

      {tab === 'filmusage' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">DTF film used</div>
              <div className="card-title">{fmtM(usedM)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Revenue realized</div>
              <div className="card-title">{fmtKsh(filmRevenue)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Usage entries</div>
              <div className="card-title">{(usages ?? []).length}</div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Film usage log
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Order</th>
                  <th style={{ textAlign: 'right' }}>Length</th>
                  <th style={{ textAlign: 'right' }}>Rate/m</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {(usages ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="text-muted">{fmtDate(u.date)}</td>
                    <td>
                      <span className={u.source === 'Order' ? 'tag tag-accent' : 'tag tag-neutral'}>{u.source}</span>
                    </td>
                    <td className="text-muted">{u.orderNo ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtM(u.lengthM)}</td>
                    <td style={{ textAlign: 'right' }}>{u.ratePerMeter != null ? fmtKsh(u.ratePerMeter) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{u.revenue != null ? fmtKsh(u.revenue) : '—'}</td>
                    <td className="text-muted">{u.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(usages ?? []).length === 0 && <p className="note">No film usage logged in range.</p>}
          </div>
        </>
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
    </div>
  );
}
