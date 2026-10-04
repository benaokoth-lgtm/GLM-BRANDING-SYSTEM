import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { OrderSummary, StaffUser } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import OrderDetailDialog from '../components/OrderDetailDialog';
import { useSubTab } from '../state/SubNavContext';

interface Props {
  scope: 'mine' | 'all';
}

export default function Orders({ scope }: Props) {
  const { staff } = useCatalog();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffFilter, setStaffFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  // One category row: All orders, Film, Artwork, then every other line of business (Embroidery, General Order, …). Film and Artwork are the
  // DTF Printing head split in two, so that head is not listed again. An order with lines in two heads shows under both. (Choosing one dims
  // the module row, like any other sub-item.)
  const [category, setCategory] = useSubTab<string>('all');
  const [detailId, setDetailId] = useState<number | null>(null);
  // My Orders keeps three kinds of document apart: an Order (paid in full), an Invoice (still has a balance, collected as it is paid)
  // and a Quotation (an offer nobody has accepted yet).
  const [kind, setKind] = useSubTab<'Order' | 'Invoice' | 'Quote'>('Order');
  // An invoice stays an invoice once it is paid in full: it is tracked through production to completion.
  const [invoiceView, setInvoiceView] = useSubTab<'all' | 'open' | 'done'>('all');

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

  const heads = (o: OrderSummary) => o.businessHeads ?? [];
  const inCategory = (o: OrderSummary, c: string) => (c === 'all' ? true : c === 'film' || c === 'artwork' ? o.dtfKind === c : c === 'DTF Printing' ? !o.dtfKind && heads(o).includes(c) : heads(o).includes(c));
  // (DTF Printing appears only for the odd general order that has a DTF line on it but is not a Film or Artwork job.)
  const otherHeads = [...new Set(orders.flatMap(heads))].filter((h) => h !== 'DTF Printing' || orders.some((o) => inCategory(o, h))).sort();
  const categories: [string, string][] = [
    ['all', 'All orders'],
    ['film', 'Film'],
    ['artwork', 'Artwork'],
    ...otherHeads.map((h): [string, string] => [h, h]),
  ];
  const ofHead = orders.filter((o) => inCategory(o, category));
  const count = (s: string) => ofHead.filter((o) => o.status === s).length;
  const invoices = ofHead.filter((o) => o.status === 'Invoice');
  const invoiceOpen = invoices.filter((o) => o.stage !== 'Completed').length;
  const shown =
    scope === 'mine'
      ? ofHead.filter((o) => o.status === kind && (kind !== 'Invoice' || invoiceView === 'all' || (invoiceView === 'open' ? o.stage !== 'Completed' : o.stage === 'Completed')))
      : ofHead;
  const showDue = scope === 'mine' && kind === 'Invoice';

  const kpis =
    scope === 'all'
      ? [
          { label: 'Total orders', value: String(ofHead.length) },
          { label: 'In production', value: String(ofHead.filter((o) => o.stage === 'In Production').length) },
          { label: 'Pending balance', value: fmtKsh(ofHead.reduce((a, o) => a + o.totals.balanceDue, 0)) },
          { label: 'Overdue invoices', value: String(ofHead.filter((o) => o.overdue).length) },
        ]
      : [];

  return (
    <div>
      <div className="seg" role="radiogroup" aria-label="Category" style={{ marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {categories.map(([k, label]) => (
          <label key={k} className={'seg-opt' + (category === k ? ' checked' : '')}>
            <input type="radio" name="ordcat" checked={category === k} onChange={() => setCategory(k)} />
            {label} ({orders.filter((o) => inCategory(o, k)).length})
          </label>
        ))}
      </div>

      {scope === 'mine' && (
        <>
          <div className="seg" role="radiogroup" style={{ marginBottom: 'var(--space-2)', maxWidth: 480 }}>
            {(
              [
                ['Order', 'Orders'],
                ['Invoice', 'Invoices'],
                ...(count('Quote') > 0 || kind === 'Quote' ? [['Quote', 'Quotations']] : []),
              ] as ['Order' | 'Invoice' | 'Quote', string][]
            ).map(([k, label]) => (
              <label key={k} className={'seg-opt' + (kind === k ? ' checked' : '')}>
                <input type="radio" name="ordkind" checked={kind === k} onChange={() => setKind(k)} />
                {label} ({count(k)})
              </label>
            ))}
          </div>
          {kind === 'Invoice' && (
            <div className="seg" role="radiogroup" style={{ marginBottom: 'var(--space-2)', maxWidth: 520 }}>
              {(
                [
                  ['all', `All (${invoices.length})`],
                  ['open', `Not yet completed (${invoiceOpen})`],
                  ['done', `Completed (${invoices.length - invoiceOpen})`],
                ] as ['all' | 'open' | 'done', string][]
              ).map(([k, label]) => (
                <label key={k} className={'seg-opt' + (invoiceView === k ? ' checked' : '')}>
                  <input type="radio" name="invview" checked={invoiceView === k} onChange={() => setInvoiceView(k)} />
                  {label}
                </label>
              ))}
            </div>
          )}
          <p className="note" style={{ marginTop: 0 }}>
            {kind === 'Order' && 'Orders are paid in full when they are captured. Anything captured with a balance is an invoice.'}
            {kind === 'Invoice' && 'An invoice stays an invoice once it is paid — it is tracked through production to completion, with its payment status shown beside it.'}
            {kind === 'Quote' && 'Quotations are offers not yet accepted — a deposit payment turns one into an invoice.'}
          </p>
        </>
      )}

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
            <th>Date</th>
            <th>Type</th>
            <th>Client</th>
            <th>Staff</th>
            <th>Status</th>
            {showDue && <th>Due</th>}
            <th>Stage</th>
            <th>Total</th>
            <th>Balance</th>
            <th>Payment</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const overdueTag = row.overdue ? 'Overdue' : row.totals.balanceDue > 0 ? 'Pending' : 'Settled';
            const overdueClass = row.overdue ? 'tag tag-accent' : row.totals.balanceDue > 0 ? 'tag tag-outline' : 'tag tag-neutral';
            return (
              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(row.id)}>
                <td>
                  {row.orderNo}
                  {row.priceApproval === 'Pending' && <div><span className="tag tag-outline">Awaiting price approval</span></div>}
                </td>
                <td className="text-muted">{fmtDate(row.createdDate)}</td>
                <td>{row.kind === 'corporate' ? 'Corporate' : row.dtfKind === 'film' ? 'Film' : row.dtfKind === 'artwork' ? 'Artwork' : row.channel === 'dtf' ? 'Film/Artwork' : 'Walk-in'}</td>
                <td>{row.kind === 'corporate' ? row.corporateClient?.name ?? '—' : row.customerName ?? '—'}</td>
                <td>{row.staff.name}</td>
                <td>
                  <span className={row.status === 'Quote' ? 'tag tag-outline' : 'tag tag-accent'}>{row.status}</span>
                </td>
                {showDue && <td className={row.overdue ? '' : 'text-muted'} style={row.overdue ? { color: '#a33', fontWeight: 700 } : undefined}>{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>}
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
      {!loading && shown.length === 0 && (
        <p className="note">{scope === 'mine' ? `No ${kind === 'Order' ? 'orders' : kind === 'Invoice' ? 'invoices' : 'quotations'} here yet.` : 'No orders here yet.'}</p>
      )}

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
