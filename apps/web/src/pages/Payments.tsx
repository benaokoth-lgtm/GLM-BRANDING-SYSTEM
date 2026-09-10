import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { OrderSummary } from '../api/models';
import OrderDetailDialog from '../components/OrderDetailDialog';

type PayTab = 'pending' | 'paid';
type Preset = 'month' | 'quarter' | 'year' | 'last12';

const TABS: [PayTab, string][] = [
  ['pending', 'Pending Payments'],
  ['paid', 'Paid'],
];

function presetRange(preset: Preset, today: string): { from: string; to: string } {
  const y = today.slice(0, 4);
  const m = today.slice(5, 7);
  if (preset === 'month') return { from: `${y}-${m}-01`, to: today };
  if (preset === 'quarter') {
    const qm = Math.floor((Number(m) - 1) / 3) * 3 + 1;
    return { from: `${y}-${String(qm).padStart(2, '0')}-01`, to: today };
  }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  const d = new Date(today + 'T00:00:00');
  d.setMonth(d.getMonth() - 11);
  d.setDate(1);
  return { from: d.toISOString().slice(0, 10), to: today };
}

export default function Payments() {
  const today = todayStr();
  const initial = presetRange('last12', today);
  const [tab, setTab] = useState<PayTab>('pending');
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);

  function load() {
    api.get<OrderSummary[]>('/orders').then(setOrders);
  }

  useEffect(load, []);

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  const inRange = orders.filter((o) => o.createdDate >= fromDate && o.createdDate <= toDate);
  const rows = tab === 'pending' ? inRange.filter((o) => o.totals.balanceDue > 0) : inRange.filter((o) => o.totals.balanceDue <= 0);

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

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('month')}>
              This month
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('quarter')}>
              This quarter
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('year')}>
              Year to date
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('last12')}>
              Last 12 months
            </button>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Date</th>
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
          {rows.map((row) => {
            const overdueTag = row.overdue ? 'Overdue' : row.totals.balanceDue > 0 ? 'Pending' : 'Settled';
            const overdueClass = row.overdue ? 'tag tag-accent' : row.totals.balanceDue > 0 ? 'tag tag-outline' : 'tag tag-neutral';
            return (
              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(row.id)}>
                <td>{row.orderNo}</td>
                <td className="text-muted">{fmtDate(row.createdDate)}</td>
                <td>{row.kind === 'corporate' ? row.corporateClient?.name ?? '—' : row.customerName ?? '—'}</td>
                <td>{row.staff.name}</td>
                <td>{fmtKsh(row.totals.grandTotal)}</td>
                <td>{fmtKsh(row.totals.paidTotal)}</td>
                <td>{fmtKsh(row.totals.balanceDue)}</td>
                <td className="text-muted">{fmtDate(row.dueDate)}</td>
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
      {rows.length === 0 && <p className="note">No {tab === 'pending' ? 'outstanding balances' : 'settled orders'} in range.</p>}

      {detailId && <OrderDetailDialog orderId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}
