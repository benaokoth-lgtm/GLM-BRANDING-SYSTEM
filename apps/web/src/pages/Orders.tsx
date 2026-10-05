import { useEffect, useState } from 'react';
import { DEFAULT_BUSINESS_HEADS, fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { OrderSummary, StaffUser } from '../api/models';
import { useCatalog } from '../hooks/useCatalog';
import { useAuth } from '../state/AuthContext';
import OrderDetailDialog from '../components/OrderDetailDialog';
import { useSubTab } from '../state/SubNavContext';

// One Orders screen for everybody. Someone who may see every order (Admin, managers) gets the whole list with the summary figures and a staff
// filter; a member of staff gets the same screen with their own orders only (the server limits the list).
export default function Orders() {
  const { staff } = useCatalog();
  const { user } = useAuth();
  const viewAll = user?.role === 'Admin' || !!user?.permissions.canViewAllOrders;
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffFilter, setStaffFilter] = useState('all');
  // One category row: All orders, then each line of business (DTF Printing, UV Printing, Embroidery, Large Format Printing, General Order). Every
  // order is counted once, under the head that carries most of its value, so the heads add up to All orders. DTF Printing opens into its film
  // sales and artwork sales. (Choosing one dims the module row, like any other sub-item.)
  const [category, setCategory] = useSubTab<string>('all');
  const [dtfPart, setDtfPart] = useSubTab<'all' | 'film' | 'artwork' | 'other'>('all');
  const [detailId, setDetailId] = useState<number | null>(null);
  // The summary figure (All Orders) that is opened into the orders behind it.
  const [openKpi, setOpenKpi] = useState<'total' | 'production' | 'pending' | 'overdue' | null>(null);
  // Everything together by default (the Status column tells an order, an invoice and a quotation apart); Invoices and Quotations narrow it.
  const [kind, setKind] = useSubTab<'all' | 'Invoice' | 'Quote'>('all');
  // An invoice stays an invoice once it is paid in full: it is tracked through production to completion.
  const [invoiceView, setInvoiceView] = useSubTab<'all' | 'open' | 'done'>('all');

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (viewAll && staffFilter !== 'all') params.set('staffId', staffFilter);
    api
      .get<OrderSummary[]>(`/orders?${params.toString()}`)
      .then(setOrders)
      .finally(() => setLoading(false));
  }

  useEffect(load, [viewAll, staffFilter]);

  const staffOnly = staff.filter((s: StaffUser) => s.role === 'Staff');

  const headRank = (h: string) => (h === 'General Order' ? 1000 : (DEFAULT_BUSINESS_HEADS as readonly string[]).indexOf(h) >= 0 ? (DEFAULT_BUSINESS_HEADS as readonly string[]).indexOf(h) : 500);
  const heads = (o: OrderSummary) => (o.businessHead ? [o.businessHead] : o.businessHeads ?? []);
  const inCategory = (o: OrderSummary, c: string) => c === 'all' || heads(o).includes(c);
  const inDtfPart = (o: OrderSummary, p: string) => (p === 'film' || p === 'artwork' ? o.dtfKind === p : p === 'other' ? !o.dtfKind : true);
  // The standing business heads are always listed (even with nothing in them yet), then any other head that has orders; General Order last.
  const categories = ['all', ...[...new Set<string>([...DEFAULT_BUSINESS_HEADS, ...orders.flatMap(heads)])].sort((a, b) => headRank(a) - headRank(b) || a.localeCompare(b))];
  const ofHead = orders.filter((o) => inCategory(o, category) && (category !== 'DTF Printing' || inDtfPart(o, dtfPart)));
  const dtfOrders = orders.filter((o) => inCategory(o, 'DTF Printing'));
  const dtfSplit: ['all' | 'film' | 'artwork' | 'other', string][] = [
    ['all', 'All DTF Printing'],
    ['film', 'Film sales'],
    ['artwork', 'Artwork sales'],
    ...(dtfOrders.some((o) => !o.dtfKind) ? [['other', 'Other DTF lines'] as ['other', string]] : []),
  ];
  const count = (s: string) => (s === 'all' ? ofHead.length : ofHead.filter((o) => o.status === s).length);
  const invoices = ofHead.filter((o) => o.status === 'Invoice');
  const invoiceOpen = invoices.filter((o) => o.stage !== 'Completed').length;
  const shown = ofHead.filter((o) => (kind === 'all' || o.status === kind) && (kind !== 'Invoice' || invoiceView === 'all' || (invoiceView === 'open' ? o.stage !== 'Completed' : o.stage === 'Completed')));
  const showDue = kind === 'Invoice';

  // The summary figures, each with the orders behind it (click one to open them). A quotation is an offer, not an order in hand or money owed,
  // so it is left out of "in production" and "pending balance".
  const live = ofHead.filter((o) => o.status !== 'Quote');
  const kpiRows: Record<'total' | 'production' | 'pending' | 'overdue', OrderSummary[]> = {
    total: ofHead,
    production: live.filter((o) => o.stage === 'In Production'),
    pending: live.filter((o) => o.totals.balanceDue > 0.005).sort((x, y) => y.totals.balanceDue - x.totals.balanceDue),
    overdue: ofHead.filter((o) => o.overdue).sort((x, y) => (x.dueDate ?? '').localeCompare(y.dueDate ?? '')),
  };
  const pendingTotal = kpiRows.pending.reduce((acc, o) => acc + o.totals.balanceDue, 0);
  const kpis = viewAll
    ? ([
        { key: 'total', label: 'Total orders', value: String(kpiRows.total.length), title: 'All orders', hint: 'Every order, invoice and quotation in the selection.' },
        { key: 'production', label: 'In production', value: String(kpiRows.production.length), title: 'In production', hint: 'Orders being worked on right now.' },
        { key: 'pending', label: 'Pending balance', value: fmtKsh(pendingTotal), title: 'Pending balances', hint: 'Orders and invoices that still have money owing, biggest balance first. Quotations are not counted.' },
        { key: 'overdue', label: 'Overdue invoices', value: String(kpiRows.overdue.length), title: 'Overdue invoices', hint: 'Invoices past their due date that still have a balance, oldest first.' },
      ] as const)
    : [];
  const openDef = kpis.find((k) => k.key === openKpi) ?? null;

  return (
    <div>
      <div className="seg" role="radiogroup" aria-label="Business head" style={{ marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {categories.map((k) => (
          <label key={k} className={'seg-opt' + (category === k ? ' checked' : '')}>
            <input
              type="radio"
              name="ordcat"
              checked={category === k}
              onChange={() => {
                setCategory(k);
                setDtfPart('all');
              }}
            />
            {k === 'all' ? 'All orders' : k} ({orders.filter((o) => inCategory(o, k)).length})
          </label>
        ))}
      </div>
      {category === 'DTF Printing' && (
        <div className="seg" role="radiogroup" aria-label="DTF Printing" style={{ marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
          {dtfSplit.map(([k, label]) => (
            <label key={k} className={'seg-opt' + (dtfPart === k ? ' checked' : '')}>
              <input type="radio" name="ordcatdtf" checked={dtfPart === k} onChange={() => setDtfPart(k)} />
              {label} ({dtfOrders.filter((o) => inDtfPart(o, k)).length})
            </label>
          ))}
        </div>
      )}

      <>
          <div className="seg" role="radiogroup" style={{ marginBottom: 'var(--space-2)', maxWidth: 480 }}>
            {(
              [
                ['all', 'All'],
                ['Invoice', 'Invoices'],
                ...(count('Quote') > 0 || kind === 'Quote' ? [['Quote', 'Quotations']] : []),
              ] as ['all' | 'Invoice' | 'Quote', string][]
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
            {kind === 'all' && 'Everything together. The Status column tells an order (paid in full when captured), an invoice (captured with a balance) and a quotation apart.'}
            {kind === 'Invoice' && 'An invoice stays an invoice once it is paid — it is tracked through production to completion, with its payment status shown beside it.'}
            {kind === 'Quote' && 'Quotations are offers not yet accepted — a deposit payment turns one into an invoice.'}
          </p>
      </>

      {viewAll && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            {kpis.map((k) => (
              <div
                key={k.label}
                className="card blueprint elev-sm"
                role="button"
                tabIndex={0}
                aria-expanded={openKpi === k.key}
                title="Show the orders behind this figure"
                onClick={() => setOpenKpi(openKpi === k.key ? null : k.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenKpi(openKpi === k.key ? null : k.key);
                  }
                }}
                style={{ cursor: 'pointer', outline: openKpi === k.key ? '2px solid var(--color-accent)' : undefined }}
              >
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">
                  {openKpi === k.key ? '▾' : '▸'} {k.label}
                </div>
                <div className="card-title">{k.value}</div>
              </div>
            ))}
          </div>
          {openDef && (
            <div className="card blueprint" style={{ padding: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="card-title">
                  {openDef.title} ({kpiRows[openDef.key].length})
                  {openDef.key === 'pending' && <span> — {fmtKsh(pendingTotal)} owing</span>}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenKpi(null)}>
                  Close
                </button>
              </div>
              <p className="note" style={{ marginTop: 'var(--space-1)' }}>
                {openDef.hint} Click an order to open it.
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Date</th>
                    <th>Client</th>
                    <th>Staff</th>
                    <th>Status</th>
                    <th>Stage</th>
                    <th>Due</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Paid</th>
                    <th style={{ textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {kpiRows[openDef.key].length === 0 && (
                    <tr>
                      <td colSpan={10} className="text-muted">
                        Nothing here.
                      </td>
                    </tr>
                  )}
                  {kpiRows[openDef.key].map((o) => (
                    <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                      <td>{o.orderNo}</td>
                      <td className="text-muted">{fmtDate(o.createdDate)}</td>
                      <td>{o.kind === 'corporate' ? o.corporateClient?.name ?? '—' : o.customerName ?? '—'}</td>
                      <td>{o.staff.name}</td>
                      <td>
                        <span className={o.status === 'Quote' ? 'tag tag-outline' : 'tag tag-accent'}>{o.status}</span>
                      </td>
                      <td className="text-muted">{o.status === 'Quote' ? '—' : o.stage}</td>
                      <td className={o.overdue ? '' : 'text-muted'} style={o.overdue ? { color: '#a33', fontWeight: 700 } : undefined}>
                        {o.dueDate ? fmtDate(o.dueDate) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(o.totals.grandTotal)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKsh(o.totals.paidTotal)}</td>
                      <td style={{ textAlign: 'right', fontWeight: o.totals.balanceDue > 0.005 ? 700 : undefined }}>{fmtKsh(o.totals.balanceDue)}</td>
                    </tr>
                  ))}
                </tbody>
                {kpiRows[openDef.key].length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={7} style={{ fontWeight: 700 }}>
                        Total
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(kpiRows[openDef.key].reduce((acc, o) => acc + o.totals.grandTotal, 0))}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(kpiRows[openDef.key].reduce((acc, o) => acc + o.totals.paidTotal, 0))}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtKsh(kpiRows[openDef.key].reduce((acc, o) => acc + o.totals.balanceDue, 0))}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
            <select className="input" style={{ width: 'auto' }} value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)}>
              <option value="all">All staff</option>
              {staffOnly.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
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
        <p className="note">No {kind === 'all' ? 'orders' : kind === 'Invoice' ? 'invoices' : 'quotations'} here yet.</p>
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
