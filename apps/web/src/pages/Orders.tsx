import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { OrderSummary, StaffUser } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import OrderDetailDialog from '../components/OrderDetailDialog';

interface Props {
  scope: 'mine' | 'all';
}

export default function Orders({ scope }: Props) {
  const { staff } = useCatalog();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffFilter, setStaffFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailId, setDetailId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (scope === 'all') {
      if (staffFilter !== 'all') params.set('staffId', staffFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
    }
    api
      .get<OrderSummary[]>(`/orders?${params.toString()}`)
      .then(setOrders)
      .finally(() => setLoading(false));
  }

  useEffect(load, [scope, staffFilter, statusFilter]);

  const staffOnly = staff.filter((s: StaffUser) => s.role === 'Staff');

  const kpis =
    scope === 'all'
      ? [
          { label: 'Total orders', value: String(orders.length) },
          { label: 'In production', value: String(orders.filter((o) => o.stage === 'In Production').length) },
          { label: 'Pending balance', value: fmtKsh(orders.reduce((a, o) => a + o.totals.balanceDue, 0)) },
          { label: 'Overdue invoices', value: String(orders.filter((o) => o.overdue).length) },
        ]
      : [];

  return (
    <div>
      {scope === 'all' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            {kpis.map((k) => (
              <div key={k.label} className="card blueprint elev-sm">
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">{k.label}</div>
                <div className="card-title">{k.value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
            <select className="input" style={{ width: 'auto' }} value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)}>
              <option value="all">All staff</option>
              {staffOnly.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="input" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="Quote">Quote</option>
              <option value="Invoice">Invoice</option>
              <option value="Order">Order</option>
            </select>
          </div>
        </>
      )}

      <table className="table" style={{ marginTop: 'var(--space-4)' }}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Type</th>
            <th>Client</th>
            <th>Staff</th>
            <th>Status</th>
            <th>Stage</th>
            <th>Total</th>
            <th>Balance</th>
            <th>Payment</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => {
            const overdueTag = row.overdue ? 'Overdue' : row.totals.balanceDue > 0 ? 'Pending' : 'Settled';
            const overdueClass = row.overdue ? 'tag tag-accent' : row.totals.balanceDue > 0 ? 'tag tag-outline' : 'tag tag-neutral';
            return (
              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(row.id)}>
                <td>{row.orderNo}</td>
                <td>{row.kind === 'corporate' ? 'Corporate' : 'Walk-in'}</td>
                <td>{row.kind === 'corporate' ? row.corporateClient?.name ?? '—' : row.customerName ?? '—'}</td>
                <td>{row.staff.name}</td>
                <td>
                  <span className={row.status === 'Quote' ? 'tag tag-outline' : 'tag tag-accent'}>{row.status}</span>
                </td>
                <td className="text-muted">{row.status === 'Quote' ? '—' : row.stage}</td>
                <td>{fmtKsh(row.totals.grandTotal)}</td>
                <td>{fmtKsh(row.totals.balanceDue)}</td>
                <td>
                  <span className={overdueClass}>{overdueTag}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!loading && orders.length === 0 && <p className="note">No orders here yet.</p>}

      {detailId && (
        <OrderDetailDialog
          orderId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
