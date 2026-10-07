import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtKsh } from '@glm/shared';
import { useSubTab } from '../state/SubNavContext';
import { HeadRow, groupByHead } from '../components/HeadGroups';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Card, DateRangeBar, Loading, Notice, Tag, money, numStyle, useLoad, useRange } from './accounting/shared';
import type { Range } from './accounting/shared';

// Production: once an order is captured it is managed here. A manager assigns each order to a staff member; the worker
// starts it, then finishes it and records what they produced; finishing sends it to Quality Control. Nothing here can mark an
// order completed — that happens only at handover, after quality control has passed it.

interface OrderBits {
  orderId: number;
  orderNo: string;
  customer: string;
  channel: string;
  businessHead: string;
  createdDate: string;
  dueDate: string | null;
  items: { name: string; qty: number }[];
  units: number;
  balanceDue: number;
  // Every line is a contracted-out service: it is sent to its supplier rather than given to a staff member.
  outsourced: boolean;
  supplierHint: string;
}
interface Task extends OrderBits {
  id: number;
  status: 'Assigned' | 'In Progress';
  isRework: boolean;
  assigneeId: number | null;
  assigneeName: string | null;
  supplierName: string | null; // set when the job is out with a supplier (no staff member)
  assignedAt: string;
  startedAt: string | null;
  assignedByName: string;
  unitsPlanned: number;
  note: string;
}
interface Queue {
  manager: boolean;
  waiting: OrderBits[];
  tasks: Task[];
  awaitingQuality: number;
  staff: { id: number; name: string; role: string; active: number }[];
}

const itemsText = (items: OrderBits['items']) => items.map((i) => `${i.name} × ${i.qty}`).join(', ');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Production() {
  const queue = useLoad<Queue>('/production/queue');
  const range = useRange();
  const [tab, setTab] = useSubTab<'jobs' | 'productivity' | 'outsourced'>('jobs');
  const manager = queue.data?.manager ?? false;
  const { user } = useAuth();
  const seeCosts = user?.role === 'Admin' || !!user?.permissions.canSeeCosts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" className={'btn blueprint ' + (tab === 'jobs' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('jobs')}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          {manager ? 'Orders & jobs' : 'My jobs'}
        </button>
        <button type="button" className={'btn blueprint ' + (tab === 'productivity' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('productivity')}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          {manager ? 'Staff productivity' : 'My output'}
        </button>
        {seeCosts && (
          <button type="button" className={'btn blueprint ' + (tab === 'outsourced' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('outsourced')}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Outsourced jobs
          </button>
        )}
      </div>
      {tab === 'jobs' && <Jobs queue={queue} />}
      {tab === 'productivity' && <Productivity range={range} />}
      {tab === 'outsourced' && seeCosts && <OutsourcedJobs />}
    </div>
  );
}

function Jobs({ queue }: { queue: ReturnType<typeof useLoad<Queue>> }) {
  const { data, error, loading, reload } = queue;
  const [pick, setPick] = useState<Record<number, string>>({}); // orderId → staff chosen
  const [supplierPick, setSupplierPick] = useState<Record<number, string>>({}); // orderId → supplier typed
  const [supplierOpen, setSupplierOpen] = useState<number | null>(null);
  const [finishing, setFinishing] = useState<number | null>(null);
  const [units, setUnits] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const assign = (orderId: number, assigneeId: number, orderNo: string, reassign = false) =>
    run(async () => {
      await api.post(`/production/orders/${orderId}/assign`, { assigneeId });
      setPick((p) => ({ ...p, [orderId]: '' }));
      return `${orderNo} ${reassign ? 'reassigned' : 'assigned'}`;
    });

  const sendToSupplier = (o: OrderBits) =>
    run(async () => {
      const supplierName = (supplierPick[o.orderId] ?? o.supplierHint).trim();
      await api.post(`/production/orders/${o.orderId}/send-to-supplier`, { supplierName });
      setSupplierOpen(null);
      return `${o.orderNo} sent to ${supplierName}`;
    });

  if (!data) return <Loading loading={loading} error={error} />;

  const StaffSelect = ({ orderId, current }: { orderId: number; current?: number }) => (
    <select className="input" style={{ width: 'auto', minWidth: 170 }} value={pick[orderId] ?? ''} onChange={(e) => setPick((p) => ({ ...p, [orderId]: e.target.value }))}>
      <option value="">{current ? 'Reassign to…' : 'Assign to…'}</option>
      {data.staff
        .filter((s) => s.id !== current)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.active} in hand)
          </option>
        ))}
    </select>
  );

  return (
    <>
      <Notice error={err || error} message={msg} />

      {data.manager && (
        <Card
          title={`Waiting to be assigned (${data.waiting.length})`}
          hint="Every captured order lands here. Give it to a staff member to start production."
        >
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Items</th>
                <th style={numStyle}>Units</th>
                <th>Payment</th>
                <th style={{ width: 340 }}>Assign</th>
              </tr>
            </thead>
            <tbody>
              {data.waiting.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    Nothing waiting — every order has someone on it.
                  </td>
                </tr>
              )}
              {groupByHead(data.waiting).map(([head, rows]) => (
                <Fragment key={head}>
                  <HeadRow head={head} count={rows.length} cols={7} />
                  {rows.map((o) => (
                <tr key={o.orderId}>
                  <td>
                    <strong>{o.orderNo}</strong> {o.channel === 'dtf' && <Tag>DTF</Tag>} {o.outsourced && <Tag>Outsourced</Tag>}
                  </td>
                  <td className="text-muted">{fmtDate(o.createdDate)}</td>
                  <td>{o.customer}</td>
                  <td className="text-muted" style={{ fontSize: 12 }}>
                    {itemsText(o.items)}
                  </td>
                  <td style={numStyle}>{o.units}</td>
                  <td>{o.balanceDue > 0 ? <Tag tone="bad">owes {fmtKsh(o.balanceDue)}</Tag> : <Tag tone="good">paid</Tag>}</td>
                  <td>
                    {(o.outsourced || supplierOpen === o.orderId) && (
                      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                        <input className="input" style={{ minWidth: 150 }} placeholder="Supplier" value={supplierPick[o.orderId] ?? o.supplierHint} onChange={(e) => setSupplierPick((p) => ({ ...p, [o.orderId]: e.target.value }))} />
                        <button type="button" className={'btn btn-sm ' + (o.outsourced ? 'btn-primary' : 'btn-secondary')} disabled={busy || !(supplierPick[o.orderId] ?? o.supplierHint).trim()} onClick={() => sendToSupplier(o)}>
                          Send to supplier
                        </button>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      <StaffSelect orderId={o.orderId} />
                      <button type="button" className={'btn btn-sm ' + (o.outsourced ? 'btn-secondary' : 'btn-primary')} disabled={busy || !pick[o.orderId]} onClick={() => assign(o.orderId, Number(pick[o.orderId]), o.orderNo)}>
                        {o.outsourced ? 'Make in-house instead' : 'Assign'}
                      </button>
                      {!o.outsourced && supplierOpen !== o.orderId && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSupplierOpen(o.orderId)}>
                          or send to a supplier…
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title={data.manager ? `In production (${data.tasks.length})` : `My jobs (${data.tasks.length})`}
        hint={
          data.manager
            ? 'Jobs in hand. A worker starts a job, then finishes it with the units produced — that sends it to Quality Control (it is not completed).'
            : 'Start a job when you begin it. When it is done, finish it and say how many units you produced — it then goes to quality control.'
        }
        actions={
          data.awaitingQuality > 0 ? (
            <Link to="/quality" className="btn btn-secondary btn-sm">
              {data.awaitingQuality} awaiting quality control →
            </Link>
          ) : undefined
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Since</th>
              <th>Customer</th>
              <th>Items</th>
              <th style={numStyle}>Units</th>
              {data.manager && <th>Assigned to</th>}
              <th>Status</th>
              <th style={{ width: data.manager ? 360 : 200 }}></th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.length === 0 && (
              <tr>
                <td colSpan={data.manager ? 8 : 7} className="text-muted">
                  {data.manager ? 'No jobs in hand.' : 'Nothing assigned to you right now.'}
                </td>
              </tr>
            )}
            {groupByHead(data.tasks).map(([head, rows]) => (
              <Fragment key={head}>
                <HeadRow head={head} count={rows.length} cols={data.manager ? 8 : 7} />
                {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.orderNo}</strong>
                </td>
                <td className="text-muted">{when(t.startedAt ?? t.assignedAt)}</td>
                <td>{t.customer}</td>
                <td className="text-muted" style={{ fontSize: 12 }}>
                  {itemsText(t.items)}
                  {t.note && <div className="note">{t.note}</div>}
                </td>
                <td style={numStyle}>{t.unitsPlanned}</td>
                {data.manager && <td>{t.assigneeName ?? <em>Supplier: {t.supplierName}</em>}</td>}
                <td>
                  <Tag tone={t.status === 'In Progress' ? 'good' : 'neutral'}>{t.assigneeId == null ? 'At supplier' : t.status}</Tag> {t.isRework && <Tag tone="bad">rework</Tag>}
                </td>
                <td>
                  {finishing === t.id ? (
                    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                      <input className="input" style={{ width: 90 }} inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder={t.assigneeId == null ? 'Units received' : 'Units made'} autoFocus />
                      <input className="input" style={{ width: 130 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || units === ''}
                        onClick={() =>
                          run(async () => {
                            await api.post(`/production/tasks/${t.id}/finish`, { unitsCompleted: Number(units), note });
                            setFinishing(null);
                            return t.assigneeId == null ? `${t.orderNo} received from ${t.supplierName} — sent to quality control` : `${t.orderNo} finished — sent to quality control`;
                          })
                        }
                      >
                        {t.assigneeId == null ? 'Receive → QC' : 'Finish → QC'}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFinishing(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      {t.status === 'Assigned' && t.assigneeId != null && (
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/production/tasks/${t.id}/start`, {}); return `${t.orderNo} started`; })}>
                          Start
                        </button>
                      )}
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setFinishing(t.id); setUnits(String(t.unitsPlanned)); setNote(''); }}>
                        {t.assigneeId == null ? 'Receive from supplier' : 'Finish'}
                      </button>
                      {data.manager && (
                        <>
                          <StaffSelect orderId={t.orderId} current={t.assigneeId ?? undefined} />
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !pick[t.orderId]} onClick={() => assign(t.orderId, Number(pick[t.orderId]), t.orderNo, true)}>
                            Reassign
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

interface OutsourcedData {
  jobs: { orderId: number; orderNo: string; customer: string; date: string; stage: string; suppliers: string[]; sale: number; estimatedCost: number; billed: number; paid: number; owing: number; costBasis: string; lines: { needsCosting: boolean }[]; margin: { grossProfit: number; markupPct: number | null; marginPct: number | null; bookProfit: number; bookMarginPct: number | null } }[];
  totals: { sale: number; billed: number; owing: number; needCosting: number };
}

// Contracted-out jobs with what the customer pays, what the supplier is owed and the profit — for people who can see costs.
function OutsourcedJobs() {
  const { data, error, loading } = useLoad<OutsourcedData>('/orders/outsourced/jobs');
  return (
    <>
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            {[
              ['Sold (VAT incl.)', fmtKsh(data.totals.sale)],
              ['Billed by suppliers', fmtKsh(data.totals.billed)],
              ['Still owed to suppliers', fmtKsh(data.totals.owing)],
              ['Jobs needing a supplier quote', String(data.totals.needCosting)],
            ].map(([k, v]) => (
              <div key={k} className="card blueprint elev-sm">
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">{k}</div>
                <div className="card-title">{v}</div>
              </div>
            ))}
          </div>
          <Card title="Contracted-out jobs" hint="Open an order (All Orders) to cost it; Finance records the supplier’s bill under Finance → Expenses. Profit in the books takes the VAT out of the sale and out of the supplier's bill (the supplier's VAT is claimed back as input VAT).">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Supplier</th>
                  <th>Stage</th>
                  <th style={numStyle}>Sold</th>
                  <th style={numStyle}>Supplier cost</th>
                  <th style={numStyle}>Paid</th>
                  <th style={numStyle}>Owing</th>
                  <th style={numStyle}>Profit (books)</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      No contracted-out jobs yet.
                    </td>
                  </tr>
                )}
                {data.jobs.map((j) => (
                  <tr key={j.orderId}>
                    <td>
                      <strong>{j.orderNo}</strong>
                      <div className="note">{fmtDate(j.date)}</div>
                    </td>
                    <td>{j.customer}</td>
                    <td>{j.suppliers.join(', ') || '—'}</td>
                    <td className="text-muted">{j.stage}</td>
                    <td style={numStyle}>{money(j.sale)}</td>
                    <td style={numStyle}>
                      {j.lines.some((l) => l.needsCosting) && j.billed === 0 ? <Tag tone="bad">needs quote</Tag> : money(j.billed > 0 ? j.billed : j.estimatedCost)}
                      <div className="note">{j.billed > 0 ? 'billed' : j.estimatedCost > 0 ? 'quote' : ''}</div>
                    </td>
                    <td style={numStyle}>{money(j.paid)}</td>
                    <td style={{ ...numStyle, fontWeight: j.owing > 0 ? 700 : undefined }}>{money(j.owing)}</td>
                    <td style={numStyle}>
                      {money(j.margin.bookProfit)}
                      <div className="note">{j.margin.bookMarginPct != null ? `${j.margin.bookMarginPct}%` : ''}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}

interface Productivity {
  manager: boolean;
  rows: { assigneeId: number; name: string; role: string; jobsFinished: number; unitsCompleted: number; unitsPlanned: number; avgHours: number | null; checked: number; passedFirstTime: number; firstPassPct: number | null; failedChecks: number; rejectedUnits: number; active: number }[];
  totals: { jobsFinished: number; unitsCompleted: number; failedChecks: number; active: number };
  daily: { date: string; units: number; jobs: number }[];
  recent: { id: number; orderNo: string; assigneeName: string; isRework: boolean; finishedAt: string; hours: number | null; unitsPlanned: number; unitsCompleted: number | null }[];
}

function Productivity({ range }: { range: Range }) {
  const { data, error, loading } = useLoad<Productivity>(`/production/productivity?from=${range.from}&to=${range.to}`);
  const maxDay = Math.max(1, ...(data?.daily ?? []).map((d) => d.units));
  return (
    <>
      <DateRangeBar range={range} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            {[
              ['Jobs finished', String(data.totals.jobsFinished)],
              ['Units produced', money(data.totals.unitsCompleted).replace(/\.00$/, '')],
              ['Failed quality checks', String(data.totals.failedChecks)],
              ['In hand now', String(data.totals.active)],
            ].map(([k, v]) => (
              <div key={k} className="card blueprint elev-sm">
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">{k}</div>
                <div className="card-title">{v}</div>
              </div>
            ))}
          </div>

          <Card
            title={data.manager ? 'Productivity by staff member' : 'My output'}
            hint="A job counts in the period it was finished. Quality is judged on first-time work: a job that fails a check stays a failure for the person who made it, even once reworked. Hours run from starting the job to finishing it."
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th style={numStyle}>Jobs finished</th>
                  <th style={numStyle}>Units produced</th>
                  <th style={numStyle}>vs planned</th>
                  <th style={numStyle}>Avg hours / job</th>
                  <th style={numStyle}>First-pass quality</th>
                  <th style={numStyle}>Failed checks</th>
                  <th style={numStyle}>Units rejected</th>
                  <th style={numStyle}>In hand</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      No production activity in this period.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.assigneeId}>
                    <td>
                      <strong>{r.name}</strong> <span className="text-muted">{r.role}</span>
                    </td>
                    <td style={numStyle}>{r.jobsFinished}</td>
                    <td style={{ ...numStyle, fontWeight: 700 }}>{r.unitsCompleted}</td>
                    <td style={numStyle}>{r.unitsPlanned ? `${Math.round((r.unitsCompleted / r.unitsPlanned) * 100)}%` : '—'}</td>
                    <td style={numStyle}>{r.avgHours ?? '—'}</td>
                    <td style={numStyle}>{r.firstPassPct == null ? '—' : <Tag tone={r.firstPassPct >= 90 ? 'good' : r.firstPassPct >= 70 ? 'neutral' : 'bad'}>{r.firstPassPct}%</Tag>}</td>
                    <td style={numStyle}>{r.failedChecks}</td>
                    <td style={numStyle}>{r.rejectedUnits}</td>
                    <td style={numStyle}>{r.active}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Daily output" hint="Units finished each day.">
            {data.daily.length === 0 ? (
              <p className="note">Nothing finished in this period.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.daily.map((d) => (
                  <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 12 }}>
                    <div style={{ width: 80 }} className="text-muted">
                      {fmtDate(d.date)}
                    </div>
                    <div style={{ flex: 1, background: 'var(--color-neutral-100)', height: 12 }}>
                      <div style={{ width: `${(d.units / maxDay) * 100}%`, height: '100%', background: 'var(--color-accent)' }} />
                    </div>
                    <div style={{ width: 120, textAlign: 'right' }}>
                      {d.units} units · {d.jobs} job{d.jobs === 1 ? '' : 's'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Recently finished jobs">
            <table className="table">
              <thead>
                <tr>
                  <th>Finished</th>
                  <th>Order</th>
                  <th>By</th>
                  <th style={numStyle}>Hours</th>
                  <th style={numStyle}>Planned</th>
                  <th style={numStyle}>Produced</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      None yet.
                    </td>
                  </tr>
                )}
                {data.recent.map((t) => (
                  <tr key={t.id}>
                    <td className="text-muted">{when(t.finishedAt)}</td>
                    <td>
                      {t.orderNo} {t.isRework && <Tag tone="bad">rework</Tag>}
                    </td>
                    <td>{t.assigneeName}</td>
                    <td style={numStyle}>{t.hours ?? '—'}</td>
                    <td style={numStyle}>{t.unitsPlanned}</td>
                    <td style={numStyle}>{t.unitsCompleted ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
