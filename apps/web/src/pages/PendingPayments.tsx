import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { OrderSummary } from '../api/models';
import OrderDetailDialog from '../components/OrderDetailDialog';

export default function PendingPayments() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);

  function load() {
    api.get<OrderSummary[]>('/orders').then(setOrders);
  }

  useEffect(load, []);

  const pending = orders.filter((o) => o.totals.balanceDue > 0);

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
        Pending payments
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Client</th>
            <th>Staff</th>
            <th>Total</th>
            <th>Paid</th>
            <th>Balance</th>
            <th>Due</th>
            <th>Progress</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {pending.map((row) => {
            const overdueTag = row.overdue ? 'Overdue' : 'Pending';
            const overdueClass = row.overdue ? 'tag tag-accent' : 'tag tag-outline';
            return (
              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(row.id)}>
                <td>{row.orderNo}</td>
                <td>{row.kind === 'corporate' ? row.corporateClient?.name ?? '—' : row.customerName ?? '—'}</td>
                <td>{row.staff.name}</td>
                <td>{fmtKsh(row.totals.grandTotal)}</td>
                <td>{fmtKsh(row.totals.paidTotal)}</td>
                <td>{fmtKsh(row.totals.balanceDue)}</td>
                <td className="text-muted">{row.dueDate || '—'}</td>
                <td style={{ minWidth: 100 }}>
                  <div style={{ background: 'var(--color-neutral-200)', height: 8, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: Math.round(row.totals.paidPct) + '%', height: '100%', background: 'var(--color-accent-600)' }} />
                  </div>
                </td>
                <td>
                  <span className={overdueClass}>{overdueTag}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pending.length === 0 && <p className="note">No outstanding balances.</p>}

      {detailId && <OrderDetailDialog orderId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}
