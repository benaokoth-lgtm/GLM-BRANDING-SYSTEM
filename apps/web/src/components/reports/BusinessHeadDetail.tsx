import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh, fmtNum } from '@glm/shared';
import { api } from '../../api/client';

// What is behind one business head's figures for the period: the sales lines (click an order to open it), the purchase-order lines tagged
// to the head and the expenses tagged to it. head = the head's name, or "__shared__" for the costs nobody tagged to a head.

interface Detail {
  head: string;
  sales: { date: string; orderId: number; orderNo: string; customer: string; item: string; qty: number; sales: number }[];
  purchases: { date: string; poRef: string | null; supplier: string; item: string; qty: number; unitCost: number; amount: number }[];
  expenses: { id: number; date: string; category: string; note: string; supplier: string; amount: number }[];
  totals: { sales: number; purchases: number; expenses: number };
}

const right = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };

export default function BusinessHeadDetail({ head, from, to, onOpenOrder }: { head: string; from: string; to: string; onOpenOrder: (orderId: number) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    api
      .get<Detail>(`/reports/business-head-detail?head=${encodeURIComponent(head)}&from=${from}&to=${to}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the detail'));
    return () => {
      live = false;
    };
  }, [head, from, to]);

  if (error) return <p className="note" style={{ color: 'var(--color-error)', padding: 'var(--space-3)' }}>{error}</p>;
  if (!data) return <p className="note" style={{ padding: 'var(--space-3)' }}>Loading…</p>;
  const shared = head === '__shared__';

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3)', background: 'var(--color-surface)', borderLeft: '3px solid var(--color-accent)', display: 'grid', gap: 'var(--space-4)' }}>
      {!shared && (
        <div>
          <div className="card-kicker">
            Sales — {data.sales.length} line{data.sales.length === 1 ? '' : 's'}, {fmtKsh(data.totals.sales)} excluding VAT
          </div>
          {data.sales.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>No sales under {data.head} in this period.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Item or service</th>
                    <th style={right}>Qty</th>
                    <th style={right}>Sales (excl. VAT)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sales.map((l, i) => (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onOpenOrder(l.orderId)} title="Open this order">
                      <td className="text-muted">{fmtDate(l.date)}</td>
                      <td>
                        <b>{l.orderNo}</b>
                      </td>
                      <td>{l.customer}</td>
                      <td>{l.item}</td>
                      <td style={right}>{fmtNum(l.qty, 2)}</td>
                      <td style={right}>{fmtKsh(l.sales)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-divider)' }}>
                    <td colSpan={5}>Total</td>
                    <td style={right}>{fmtKsh(data.totals.sales)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="card-kicker">
          Purchases tagged to {shared ? 'no head' : data.head} — {fmtKsh(data.totals.purchases)}
        </div>
        {data.purchases.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>None in this period.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>PO</th>
                  <th>Supplier</th>
                  <th>Item</th>
                  <th style={right}>Qty</th>
                  <th style={right}>Unit cost</th>
                  <th style={right}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.purchases.map((p, i) => (
                  <tr key={i}>
                    <td className="text-muted">{fmtDate(p.date)}</td>
                    <td>{p.poRef ?? '—'}</td>
                    <td className="text-muted">{p.supplier || '—'}</td>
                    <td>{p.item}</td>
                    <td style={right}>{fmtNum(p.qty, 2)}</td>
                    <td style={right}>{fmtNum(p.unitCost, 2)}</td>
                    <td style={right}>{fmtKsh(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="card-kicker">
          Expenses tagged to {shared ? 'no head' : data.head} — {fmtKsh(data.totals.expenses)}
        </div>
        {data.expenses.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>None in this period.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Note</th>
                  <th>Supplier</th>
                  <th style={right}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.expenses.map((e) => (
                  <tr key={e.id}>
                    <td className="text-muted">{fmtDate(e.date)}</td>
                    <td>{e.category}</td>
                    <td className="text-muted">{e.note}</td>
                    <td className="text-muted">{e.supplier || '—'}</td>
                    <td style={right}>{fmtKsh(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
