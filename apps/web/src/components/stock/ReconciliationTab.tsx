import { useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import type { ReconciliationData, ReconLineRow } from '../../api/models';
import { Card, DateRangeBar, Loading, Tag, numStyle, printPage, useLoad, useRange } from '../../pages/accounting/shared';

// Stock → Purchases Reconciliation. For every approved requisition: what was requisitioned (quantity and the expected price) against
// what was bought and what the store manager physically received, with the variance in quantity, price and total — per line and per
// requisition reference. The money variance splits into a price part (paid more or less per unit) and a quantity part (bought more or
// less than asked), and those two add up exactly to the total.

const qty = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-KE');
const signedQty = (n: number | null) => (n == null ? '—' : n === 0 ? '0' : `${n > 0 ? '+' : ''}${qty(n)}`);
const signedKsh = (n: number | null) => (n == null ? '—' : Math.abs(n) < 0.005 ? '0' : `${n > 0 ? '+' : '−'}${fmtKsh(Math.abs(n)).replace('Ksh ', '')}`);
// Spending more, or receiving less than was asked for, is the adverse direction.
const adverseMoney = (n: number | null) => (n != null && n > 0.005 ? { color: 'var(--color-error)', fontWeight: 700 } : undefined);
const adverseQty = (n: number | null) => (n != null && n < 0 ? { color: 'var(--color-error)', fontWeight: 700 } : undefined);

function stateTone(state: string): 'good' | 'bad' | 'neutral' {
  return state === 'Received' ? 'good' : state === 'Not purchased' ? 'bad' : 'neutral';
}

function LineRow({ l }: { l: ReconLineRow }) {
  return (
    <tr>
      <td>
        {l.name}
        {l.status === 'Not requisitioned' && <div><Tag tone="bad">not requisitioned</Tag></div>}
        {l.status === 'Awaiting receipt' && <div className="note" style={{ margin: 0 }}>awaiting receipt</div>}
        {l.status === 'Not purchased' && <div className="note" style={{ margin: 0 }}>not purchased yet</div>}
      </td>
      <td style={numStyle}>{l.requisitionedQty ? qty(l.requisitionedQty) : '—'}</td>
      <td style={numStyle}>{l.purchasedQty ? qty(l.purchasedQty) : '—'}</td>
      <td style={numStyle}>{l.status === 'Awaiting receipt' || l.status === 'Not purchased' ? '—' : qty(l.receivedQty)}</td>
      <td style={{ ...numStyle, ...adverseQty(l.qtyVariance) }}>{signedQty(l.qtyVariance)}</td>
      <td style={{ ...numStyle, ...adverseQty(l.shortDelivery ? -l.shortDelivery : 0) }}>{l.shortDelivery ? qty(l.shortDelivery) : '—'}</td>
      <td style={numStyle}>{l.expectedUnitCost != null ? fmtKsh(l.expectedUnitCost).replace('Ksh ', '') : '—'}</td>
      <td style={numStyle}>{l.actualUnitCost != null ? fmtKsh(l.actualUnitCost).replace('Ksh ', '') : '—'}</td>
      <td style={{ ...numStyle, ...adverseMoney(l.priceVarianceUnit) }}>{signedKsh(l.priceVarianceUnit)}</td>
      <td style={numStyle}>{l.expectedTotal != null ? fmtKsh(l.expectedTotal).replace('Ksh ', '') : '—'}</td>
      <td style={numStyle}>{l.actualTotal ? fmtKsh(l.actualTotal).replace('Ksh ', '') : '—'}</td>
      <td style={{ ...numStyle, ...adverseMoney(l.totalVariance) }}>
        {l.status === 'Not requisitioned' ? signedKsh(l.actualTotal) : signedKsh(l.totalVariance)}
      </td>
    </tr>
  );
}

export default function ReconciliationTab() {
  const range = useRange();
  const [onlyVariance, setOnlyVariance] = useState(false);
  const { data, error, loading } = useLoad<ReconciliationData>(`/stock/reconciliation?from=${range.from}&to=${range.to}${onlyVariance ? '&variance=1' : ''}`);
  const s = data?.summary;

  return (
    <>
      <Card
        title="Purchases reconciliation"
        hint="What was requisitioned against what was bought and what the store manager physically received. Red is adverse: spending more than expected, or receiving less than was asked for."
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
            Print
          </button>
        }
      >
        <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <DateRangeBar range={range} />
          <label style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={onlyVariance} onChange={(e) => setOnlyVariance(e.target.checked)} /> only requisitions with a variance
          </label>
        </div>
        <p className="note" style={{ marginBottom: 0 }}>Requisitions raised {fmtDate(range.from)} to {fmtDate(range.to)}.</p>
      </Card>

      {!data ? (
        <Loading loading={loading} error={error} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            {[
              ['Requisitions', String(s!.requisitions)],
              ['Expected', fmtKsh(s!.expectedTotal)],
              ['Actually spent', fmtKsh(s!.actualTotal)],
              ['Total variance', signedKsh(s!.totalVariance) === '0' ? 'Ksh 0' : `${s!.totalVariance > 0 ? '+' : '−'}${fmtKsh(Math.abs(s!.totalVariance))}`],
              ['of which price', signedKsh(s!.priceVarianceValue)],
              ['of which quantity', signedKsh(s!.qtyVarianceValue)],
              ['Short deliveries', fmtKsh(s!.shortDeliveryValue)],
            ].map(([k, v]) => (
              <div key={k} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', minWidth: 130, flex: '1 1 130px' }}>
                <div className="card-kicker">{k}</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>{v}</div>
              </div>
            ))}
          </div>

          {data.requisitions.length === 0 && <p className="note">No approved requisitions in this period.</p>}

          {data.requisitions.map((r) => (
            <Card
              key={r.id}
              title={
                <>
                  {r.ref} <Tag tone={stateTone(r.state)}>{r.state}</Tag>
                </>
              }
              hint={`Requested by ${r.requestedByName} on ${fmtDate(r.requestedAt.slice(0, 10))}${r.note ? ` — ${r.note}` : ''}${r.purchaseOrders.length ? ` · ${r.purchaseOrders.map((p) => p.poRef).join(', ')}` : ''}`}
            >
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th style={numStyle}>Requisitioned</th>
                      <th style={numStyle}>Purchased</th>
                      <th style={numStyle}>Received in store</th>
                      <th style={numStyle}>Qty variance</th>
                      <th style={numStyle}>Short delivery</th>
                      <th style={numStyle}>Expected price</th>
                      <th style={numStyle}>Actual price</th>
                      <th style={numStyle}>Price variance</th>
                      <th style={numStyle}>Expected total</th>
                      <th style={numStyle}>Actual total</th>
                      <th style={numStyle}>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l) => (
                      <LineRow key={l.materialId} l={l} />
                    ))}
                    {r.state === 'Not purchased' ? (
                      <tr>
                        <td colSpan={12} className="text-muted">
                          Nothing has been purchased against {r.ref} yet, so there is nothing to reconcile.
                        </td>
                      </tr>
                    ) : (
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}>
                        <td colSpan={9}>
                          Total for {r.ref}
                          <span className="text-muted" style={{ fontWeight: 400 }}>
                            {' '}— price {signedKsh(r.totals.priceVarianceValue)} · quantity {signedKsh(r.totals.qtyVarianceValue)}
                            {r.state === 'Part purchased' ? ' · bought items only, some lines are not purchased yet' : ''}
                            {r.totals.unpricedLines > 0 ? ` · ${r.totals.unpricedLines} item${r.totals.unpricedLines === 1 ? '' : 's'} had no expected price` : ''}
                          </span>
                        </td>
                        <td style={numStyle}>{fmtKsh(r.totals.expectedTotal).replace('Ksh ', '')}</td>
                        <td style={numStyle}>{fmtKsh(r.totals.actualTotal).replace('Ksh ', '')}</td>
                        <td style={{ ...numStyle, ...adverseMoney(r.totals.totalVariance) }}>{signedKsh(r.totals.totalVariance)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}

          <Card title="Purchases with no requisition" hint="Money spent on stock that nobody requisitioned first.">
            {data.standalone.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>None in this period.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>PO</th>
                      <th>Date</th>
                      <th>Supplier / invoice</th>
                      <th>Items</th>
                      <th style={numStyle}>Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.standalone.map((p) => (
                      <tr key={p.id}>
                        <td>{p.poRef}</td>
                        <td className="text-muted">{fmtDate(p.date)}</td>
                        <td>
                          {p.supplier || '—'}
                          <div className="note" style={{ margin: 0 }}>{p.invoiceNumber || ''}</div>
                        </td>
                        <td style={{ fontSize: 12 }}>{p.items}</td>
                        <td style={numStyle}>{fmtKsh(p.totalCost)}</td>
                        <td>
                          <Tag>{p.status === 'Accepted' ? 'Received' : 'Awaiting receipt'}</Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
