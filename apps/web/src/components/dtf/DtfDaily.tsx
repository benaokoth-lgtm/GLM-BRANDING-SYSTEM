import { Fragment, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, fmtNum, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import OrderDetailDialog from '../OrderDetailDialog';
import { Card, right } from './shared';
import type { DtfTabProps } from './shared';

// DTF history, a day at a time. Each date is one line — for artwork jobs: how many were printed, the metres used, the average price, the
// average recommended and final price, and the money (total, paid, balance); for film sales: the metres sold, the average price a metre and
// the money. Click a date to see every individual order of that day, and an order to open it. Money comes from the orders themselves, so a
// payment taken later through the order shows up here.

interface JobOrder {
  jobId: string | number;
  orderId: number | null;
  orderNo: string | null;
  client: string;
  rollId: string;
  pieces: number;
  runningMetres: number;
  recommendedPerPiece: number;
  finalPerPiece: number;
  approval: string;
  capturedByName: string;
  total: number;
  paid: number;
  balance: number;
}
interface JobDay {
  date: string;
  count: number;
  pendingApproval: number;
  pieces: number;
  metres: number;
  avgPricePerJob: number | null;
  avgRecommendedPerPiece: number | null;
  avgFinalPerPiece: number | null;
  total: number;
  paid: number;
  balance: number;
  orders: JobOrder[];
}
interface SaleOrder {
  saleId: string | number;
  orderId: number | null;
  orderNo: string | null;
  client: string;
  rollId: string;
  metres: number;
  pricePerM: number;
  stdPricePerM: number;
  capturedByName: string;
  total: number;
  paid: number;
  balance: number;
}
interface SaleDay {
  date: string;
  count: number;
  metres: number;
  avgPricePerM: number | null;
  total: number;
  paid: number;
  balance: number;
  orders: SaleOrder[];
}

const ksh = (n: number | null) => (n == null ? '—' : fmtKsh(n));
const RANGES: [string, string, number | null][] = [
  ['30', 'Last 30 days', 30],
  ['90', 'Last 90 days', 90],
  ['365', 'Last 12 months', 365],
  ['all', 'All dates', null],
];
function daysAgo(n: number): string {
  const d = new Date(todayStr() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function DtfDaily({ kind, reload, setError }: { kind: 'jobs' | 'sales' } & DtfTabProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [rangeKey, setRangeKey] = useState('90');
  const [days, setDays] = useState<(JobDay | SaleDay)[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    const days = RANGES.find(([k]) => k === rangeKey)?.[2] ?? null;
    api
      .get<{ days: (JobDay | SaleDay)[] }>(`/dtf/daily?kind=${kind}${days ? `&from=${daysAgo(days)}&to=${todayStr()}` : ''}`)
      .then((r) => setDays(r.days))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the daily figures'))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [rangeKey, kind]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const clickable = { cursor: 'pointer' } as const;
  const isJobs = kind === 'jobs';
  const cols = isJobs ? 10 : 7;

  return (
    <>
      <Card
        title={isJobs ? 'Artwork jobs — day by day' : 'Film sales — day by day'}
        noPrint={false}
      >
        <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
          {RANGES.map(([k, label]) => (
            <button key={k} type="button" className={'btn btn-sm ' + (rangeKey === k ? 'btn-primary' : 'btn-secondary')} onClick={() => setRangeKey(k)}>
              {label}
            </button>
          ))}
          <span className="note" style={{ margin: 0 }}>Click a date to see that day’s orders; click an order to open it.</span>
        </div>
        {loading ? (
          <p className="note">Loading…</p>
        ) : days.length === 0 ? (
          <p className="note">{isJobs ? 'No artwork jobs' : 'No film sales'} in this period.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                {isJobs ? (
                  <tr>
                    <th>Date</th>
                    <th style={right}>Jobs printed</th>
                    <th style={right}>Pieces</th>
                    <th style={right}>Metres used</th>
                    <th style={right}>Avg price / job</th>
                    <th style={right}>Avg recommended / pc</th>
                    <th style={right}>Avg final / pc</th>
                    <th style={right}>Total</th>
                    <th style={right}>Paid</th>
                    <th style={right}>Balance</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Date</th>
                    <th style={right}>Sales</th>
                    <th style={right}>Metres sold</th>
                    <th style={right}>Avg price / m</th>
                    <th style={right}>Total</th>
                    <th style={right}>Paid</th>
                    <th style={right}>Balance</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {days.map((d) => {
                  const isOpen = open === d.date;
                  const j = d as JobDay;
                  const s = d as SaleDay;
                  return (
                    <Fragment key={d.date}>
                      <tr
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : d.date)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpen(isOpen ? null : d.date);
                          }
                        }}
                        style={{ ...clickable, background: isOpen ? 'var(--color-surface)' : undefined }}
                        title="Show this day's orders"
                      >
                        <td>
                          <span className="text-muted">{isOpen ? '▾' : '▸'}</span> <b>{fmtDate(d.date)}</b>
                        </td>
                        {isJobs ? (
                          <>
                            <td style={right}>
                              {j.count}
                              {j.pendingApproval > 0 && <span className="tag tag-outline" style={{ marginLeft: 6 }}>+{j.pendingApproval} awaiting approval</span>}
                            </td>
                            <td style={right}>{fmtNum(j.pieces)}</td>
                            <td style={right}>{fmtNum(j.metres, 2)}</td>
                            <td style={right}>{ksh(j.avgPricePerJob)}</td>
                            <td style={right}>{j.avgRecommendedPerPiece == null ? '—' : fmtNum(j.avgRecommendedPerPiece, 2)}</td>
                            <td style={right}>{j.avgFinalPerPiece == null ? '—' : fmtNum(j.avgFinalPerPiece, 2)}</td>
                          </>
                        ) : (
                          <>
                            <td style={right}>{s.count}</td>
                            <td style={right}>{fmtNum(s.metres, 2)}</td>
                            <td style={right}>{s.avgPricePerM == null ? '—' : fmtNum(s.avgPricePerM, 2)}</td>
                          </>
                        )}
                        <td style={{ ...right, fontWeight: 700 }}>{fmtKsh(d.total)}</td>
                        <td style={right}>{fmtKsh(d.paid)}</td>
                        <td style={{ ...right, color: d.balance > 0 ? '#a33' : undefined, fontWeight: d.balance > 0 ? 700 : undefined }}>{d.balance > 0 ? fmtKsh(d.balance) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={cols} style={{ padding: 0 }}>
                            <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3)', background: 'var(--color-surface)', borderLeft: '3px solid var(--color-accent)' }}>
                              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
                                {fmtDate(d.date)} — {isJobs ? j.orders.length : s.orders.length} order{(isJobs ? j.orders.length : s.orders.length) === 1 ? '' : 's'}
                              </div>
                              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                                <thead>
                                  {isJobs ? (
                                    <tr>
                                      <th>Order</th>
                                      <th>Client</th>
                                      <th>Roll</th>
                                      <th style={right}>Pieces</th>
                                      <th style={right}>Metres</th>
                                      <th style={right}>Recommended / pc</th>
                                      <th style={right}>Final / pc</th>
                                      <th style={right}>Total</th>
                                      <th style={right}>Paid</th>
                                      <th style={right}>Balance</th>
                                      <th>Captured by</th>
                                      <th className="no-print"></th>
                                    </tr>
                                  ) : (
                                    <tr>
                                      <th>Order</th>
                                      <th>Client</th>
                                      <th>Roll</th>
                                      <th style={right}>Metres</th>
                                      <th style={right}>Price / m</th>
                                      <th style={right}>Total</th>
                                      <th style={right}>Paid</th>
                                      <th style={right}>Balance</th>
                                      <th>Captured by</th>
                                      <th className="no-print"></th>
                                    </tr>
                                  )}
                                </thead>
                                <tbody>
                                  {isJobs
                                    ? j.orders.map((o) => (
                                        <tr key={o.jobId} style={o.orderId ? clickable : undefined} onClick={() => o.orderId && setOrderId(o.orderId)}>
                                          <td>
                                            <b>{o.orderNo ?? '—'}</b>
                                            {o.approval === 'Pending' && <div><span className="tag tag-outline">Awaiting approval</span></div>}
                                          </td>
                                          <td>{o.client}</td>
                                          <td>{o.rollId}</td>
                                          <td style={right}>{fmtNum(o.pieces)}</td>
                                          <td style={right}>{fmtNum(o.runningMetres, 2)}</td>
                                          <td style={right}>{fmtNum(o.recommendedPerPiece, 2)}</td>
                                          <td style={{ ...right, color: o.finalPerPiece < o.recommendedPerPiece ? '#a33' : undefined }}>{fmtNum(o.finalPerPiece, 2)}</td>
                                          <td style={{ ...right, fontWeight: 700 }}>{fmtKsh(o.total)}</td>
                                          <td style={right}>{fmtKsh(o.paid)}</td>
                                          <td style={right}>{o.balance > 0 ? fmtKsh(o.balance) : '—'}</td>
                                          <td className="text-muted">{o.capturedByName}</td>
                                          <td className="no-print" onClick={(e) => e.stopPropagation()}>
                                            {isAdmin && (
                                              <button
                                                type="button"
                                                className="btn btn-ghost btn-sm"
                                                disabled={busy}
                                                onClick={() => window.confirm(`Delete this job (${o.orderNo ?? o.rollId}, ${fmtNum(o.runningMetres, 2)} m)?`) && act(() => api.del(`/dtf/jobs/${o.jobId}`))}
                                              >
                                                Delete
                                              </button>
                                            )}
                                          </td>
                                        </tr>
                                      ))
                                    : s.orders.map((o) => (
                                        <tr key={o.saleId} style={o.orderId ? clickable : undefined} onClick={() => o.orderId && setOrderId(o.orderId)}>
                                          <td>
                                            <b>{o.orderNo ?? '—'}</b>
                                          </td>
                                          <td>{o.client}</td>
                                          <td>{o.rollId}</td>
                                          <td style={right}>{fmtNum(o.metres, 2)}</td>
                                          <td style={right}>{fmtNum(o.pricePerM, 2)}</td>
                                          <td style={{ ...right, fontWeight: 700 }}>{fmtKsh(o.total)}</td>
                                          <td style={right}>{fmtKsh(o.paid)}</td>
                                          <td style={right}>{o.balance > 0 ? fmtKsh(o.balance) : '—'}</td>
                                          <td className="text-muted">{o.capturedByName}</td>
                                          <td className="no-print" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                                            {o.balance > 0 && (
                                              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/dtf/sales/${o.saleId}/paid`, { amountPaid: Math.round(o.metres * o.pricePerM * 100) / 100 }))}>
                                                Mark paid
                                              </button>
                                            )}
                                            {isAdmin && (
                                              <button
                                                type="button"
                                                className="btn btn-ghost btn-sm"
                                                disabled={busy}
                                                onClick={() => window.confirm(`Delete this sale (${o.rollId}, ${fmtNum(o.metres, 2)} m)?`) && act(() => api.del(`/dtf/sales/${o.saleId}`))}
                                              >
                                                Delete
                                              </button>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          {isJobs
            ? 'Total, paid and balance come from the orders (they include the heat press fee and any merchandise sold with the job). Average recommended and final price are per piece, weighted by pieces; average price per job is the day’s total over its jobs. Jobs waiting for a price approval are listed but not counted until approved.'
            : 'Total, paid and balance come from the orders (they include any merchandise sold with the film). Average price per metre is weighted by metres.'}
        </p>
      </Card>

      {orderId != null && <OrderDetailDialog orderId={orderId} onClose={() => setOrderId(null)} onChanged={load} />}
    </>
  );
}
