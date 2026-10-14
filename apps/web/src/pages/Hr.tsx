import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { dateRange, dateSpanLabel, fmtDate, fmtKsh, leaveWorkingDays, todayStr } from '@glm/shared';
import { api } from '../api/client';
import { numStyle } from './accounting/shared';

// People (HR): leave requests and their approval, the off-day calendar, the leave policy and performance reviews. Everyone with HR access asks for their own leave and sees the calendar;
// people who manage HR also see the overview and everyone's leave, decide requests, run reviews and keep the policy. Days are working days (not the weekly days off, public holidays or
// company off days), worked out by the same rules the server uses.

interface LeaveType {
  id: number;
  name: string;
  paid: boolean;
  daysPerYear: number;
  accrual: 'monthly' | 'upfront';
  carryOverCap: number;
  certAfterDays: number;
  active: boolean;
}
interface Config {
  canManage: boolean;
  me: { id: number; name: string };
  leaveTypes: LeaveType[];
  settings: { minCover: number; offWeekdays: number[] };
  staff: { id: number; name: string; role: string; hireDate: string | null }[];
  offDays: { id: number; date: string; name: string }[];
}
interface Balance {
  typeId: number;
  name: string;
  paid: boolean;
  unlimited: boolean;
  entitled: number;
  carried: number;
  taken: number;
  pending: number;
  remaining: number;
  available: number;
}
interface Req {
  id: number;
  staffId: number;
  staffName: string;
  role: string;
  leaveTypeId: number;
  type: string;
  startDate: string;
  endDate: string;
  label: string;
  days: number;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';
  reason: string;
  certificate: boolean;
  decidedByName: string;
  decisionNote: string;
}
interface Overview {
  staff: { total: number; onLeaveToday: number; working: number; todayIsWorkingDay: boolean };
  pending: { count: number; oldestDays: number; list: Req[] };
  leaveThisMonth: { days: number };
  liability: { days: number; amount: number; staffWithoutSalary: number };
  coverage: { date: string; staffed: number; total: number; min: number }[];
}
interface CalDay {
  date: string;
  weekday: number;
  off: 'weekend' | 'holiday' | null;
  name: string | null;
  people: { requestId: number; staffId: number; name: string; type: string; status: string }[];
  away: number;
  atWork: number;
  belowCover: boolean;
}
interface PerfRow {
  staffId: number;
  name: string;
  role: string;
  hireDate: string | null;
  sales: number | null;
  target: number | null;
  salesVsTarget: number | null;
  orders: number | null;
  commission: number | null;
  leaveDays: number;
  review: { goalsMet: number; goalsTotal: number; rating: number | null; note: string; status: 'Draft' | 'Done'; reviewerName: string } | null;
}

type Tab = 'overview' | 'leave' | 'calendar' | 'perf' | 'policy';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_NO = [1, 2, 3, 4, 5, 6, 0]; // Monday first → JavaScript's weekday numbers
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (m: string, by: number) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1)).toISOString().slice(0, 7);
const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const errMsg = (e: unknown, fallback = 'That did not work') => (e instanceof Error ? e.message : fallback);

const corners = (
  <>
    <i className="corner tl"></i>
    <i className="corner tr"></i>
    <i className="corner bl"></i>
    <i className="corner br"></i>
  </>
);
const statusTag = (s: string) => <span className={'tag ' + (s === 'Approved' ? 'tag-accent' : s === 'Pending' ? 'tag-outline' : 'tag-neutral')}>{s.toLowerCase()}</span>;

export default function Hr() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('leave');
  const [dialog, setDialog] = useState(false);
  // bumped whenever a request changes, so every tab reloads
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const loadConfig = useCallback(() => {
    api
      .get<Config>('/hr/config')
      .then((c) => {
        setCfg(c);
        setTab((t) => (c.canManage ? (t === 'leave' && version === 0 ? 'overview' : t) : t === 'overview' || t === 'perf' || t === 'policy' ? 'leave' : t));
      })
      .catch((e) => setErr(errMsg(e, 'Could not load People')));
  }, [version]);
  useEffect(loadConfig, [loadConfig]);

  if (!cfg) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;
  const tabs: [Tab, string][] = cfg.canManage
    ? [['overview', 'Overview'], ['leave', 'Leave requests'], ['calendar', 'Off-day calendar'], ['perf', 'Performance'], ['policy', 'Policy']]
    : [['leave', 'My leave'], ['calendar', 'Off-day calendar']];

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div className="card-kicker">People · {monthName(todayStr().slice(0, 7))}</div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 38, lineHeight: 1.05, margin: 0 }}>Leave, off days &amp; performance</h1>
        </div>
        <button type="button" className="btn btn-primary blueprint" onClick={() => setDialog(true)}>
          {corners}+ New leave request
        </button>
      </div>

      <div className="seg" role="radiogroup" aria-label="People" style={{ maxWidth: 760 }}>
        {tabs.map(([id, label]) => (
          <label key={id} className={'seg-opt' + (tab === id ? ' checked' : '')}>
            <input type="radio" name="hrtab" checked={tab === id} onChange={() => setTab(id)} />
            {label}
          </label>
        ))}
      </div>

      {tab === 'overview' && cfg.canManage && <OverviewTab cfg={cfg} version={version} onChanged={bump} goLeave={() => setTab('leave')} />}
      {tab === 'leave' && <LeaveTab cfg={cfg} version={version} onChanged={bump} />}
      {tab === 'calendar' && <CalendarTab version={version} canManage={cfg.canManage} />}
      {tab === 'perf' && cfg.canManage && <PerformanceTab cfg={cfg} />}
      {tab === 'policy' && cfg.canManage && <PolicyTab cfg={cfg} reload={loadConfig} />}

      {dialog && (
        <NewRequestDialog
          cfg={cfg}
          onClose={() => setDialog(false)}
          onDone={() => {
            setDialog(false);
            setTab('leave');
            bump();
          }}
        />
      )}
    </div>
  );
}

// ── deciding a request: approve (confirming if it leaves the shop short) or reject with a reason ─────────────────────────────────────────────────────
function useDecide(onChanged: () => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function approve(id: number) {
    setBusy(true);
    setError('');
    try {
      try {
        await api.post(`/hr/requests/${id}/approve`, {});
      } catch (e) {
        // below the minimum: the decider is asked, and may go ahead
        const needs = (e as { status?: number }).status === 409 || /Approve it anyway\?/.test(errMsg(e));
        if (!needs || !window.confirm(errMsg(e))) throw needs ? new Error('Not approved') : e;
        await api.post(`/hr/requests/${id}/approve`, { confirm: true });
      }
      onChanged();
    } catch (e) {
      if (errMsg(e) !== 'Not approved') setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function reject(id: number) {
    const reason = window.prompt('Why is this request rejected? (the person will see it)');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/hr/requests/${id}/reject`, { reason: reason.trim() });
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: number) {
    if (!window.confirm('Cancel this leave request?')) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/hr/requests/${id}/cancel`, {});
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, approve, reject, cancel };
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────
function OverviewTab({ cfg, version, onChanged, goLeave }: { cfg: Config; version: number; onChanged: () => void; goLeave: () => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const decide = useDecide(onChanged);
  useEffect(() => {
    api.get<Overview>('/hr/overview').then(setO).catch((e) => setErr(errMsg(e)));
  }, [version]);
  if (!o) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;
  const min = cfg.settings.minCover;
  const under = o.coverage.filter((c) => min > 0 && c.staffed < min);
  const kpi = (label: string, value: string, note: string) => (
    <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
      {corners}
      <div className="card-kicker">{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 13, color: 'var(--color-accent)' }}>{note}</div>
    </div>
  );
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)' }}>
        {kpi('Staff at work today', o.staff.todayIsWorkingDay ? `${o.staff.working}/${o.staff.total}` : 'Day off', o.staff.todayIsWorkingDay ? `${o.staff.onLeaveToday} on approved leave` : 'a weekly day off or public holiday')}
        {kpi('Pending requests', String(o.pending.count), o.pending.count ? `oldest ${o.pending.oldestDays} day${o.pending.oldestDays === 1 ? '' : 's'}` : 'none waiting')}
        {kpi('Leave taken this month', `${o.leaveThisMonth.days} d`, 'approved working days')}
        {kpi('Leave liability', fmtKsh(o.liability.amount), `${Math.round(o.liability.days * 10) / 10} unused annual days at daily pay${o.liability.staffWithoutSalary ? ` · ${o.liability.staffWithoutSalary} without a salary on record` : ''}`)}
      </div>
      {decide.error && <p className="note" role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{decide.error}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          {corners}
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Needs your decision</div>
          {o.pending.list.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>All requests decided.</p>
          ) : (
            o.pending.list.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', padding: '8px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'center' }}>
                <div>
                  <b>{r.staffName}</b>
                  <div className="text-muted" style={{ fontSize: 13 }}>{r.type} · {r.label} · {r.days}d</div>
                </div>
                {r.staffId === cfg.me.id ? (
                  <span className="text-muted" style={{ fontSize: 12 }}>your own: another manager decides</span>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={decide.busy} onClick={() => decide.reject(r.id)}>Reject</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={decide.busy} onClick={() => decide.approve(r.id)}>Approve</button>
                  </div>
                )}
              </div>
            ))
          )}
          {o.pending.count > o.pending.list.length && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-2)' }} onClick={goLeave}>
              All {o.pending.count} requests
            </button>
          )}
        </div>
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          {corners}
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Cover this week</div>
          {o.coverage.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>No working days left this week.</p>
          ) : (
            o.coverage.map((c) => {
              const low = min > 0 && c.staffed < min;
              return (
                <div key={c.date} style={{ display: 'grid', gridTemplateColumns: '48px 1fr 70px', gap: 'var(--space-2)', alignItems: 'center', margin: '6px 0' }}>
                  <span>{dateSpanLabel(c.date, c.date).slice(0, 3)}</span>
                  <div style={{ height: 10, border: '1px solid var(--color-accent)' }}>
                    <div style={{ height: '100%', width: `${c.total ? (c.staffed / c.total) * 100 : 0}%`, background: low ? 'var(--color-error)' : 'var(--color-accent)', opacity: low ? 1 : 0.55 }} />
                  </div>
                  <span style={{ textAlign: 'right' }}>{c.staffed}/{c.total}</span>
                </div>
              );
            })
          )}
          <p className="note" style={{ marginBottom: 0 }}>
            {min > 0 ? (under.length ? `${under.map((u) => dateSpanLabel(u.date, u.date)).join(', ')} ${under.length === 1 ? 'is' : 'are'} under the minimum of ${min} at work.` : `Every day is at or above the minimum of ${min} at work.`) : 'No minimum is set (Policy). People at work = staff less approved leave.'}
          </p>
        </div>
      </div>
    </>
  );
}

// ── Leave requests ───────────────────────────────────────────────────────────────────────────────
function LeaveTab({ cfg, version, onChanged }: { cfg: Config; version: number; onChanged: () => void }) {
  const [filter, setFilter] = useState<'all' | 'Pending' | 'Approved' | 'Rejected' | 'Cancelled'>('all');
  const [who, setWho] = useState<number>(cfg.me.id);
  const [rows, setRows] = useState<Req[] | null>(null);
  const [bal, setBal] = useState<Balance[]>([]);
  const [err, setErr] = useState('');
  const decide = useDecide(onChanged);
  const year = Number(todayStr().slice(0, 4));

  useEffect(() => {
    api.get<Req[]>(`/hr/requests?year=${year}${cfg.canManage ? '' : ''}`).then(setRows).catch((e) => setErr(errMsg(e)));
  }, [version, cfg.canManage, year]);
  useEffect(() => {
    api.get<{ balances: Balance[] }>(`/hr/balances?staffId=${who}&year=${year}`).then((r) => setBal(r.balances)).catch(() => setBal([]));
  }, [who, version, year]);

  const shown = useMemo(() => (rows ?? []).filter((r) => filter === 'all' || r.status === filter), [rows, filter]);
  if (!rows) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;

  return (
    <>
      <div>
        {cfg.canManage && (
          <div className="field" style={{ margin: '0 0 var(--space-2)', maxWidth: 280 }}>
            <label>Balances for</label>
            <select className="input" value={who} onChange={(e) => setWho(Number(e.target.value))}>
              {cfg.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === cfg.me.id ? ' (me)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)' }}>
          {bal.map((b) => (
            <div key={b.typeId} className="card blueprint" style={{ padding: 'var(--space-3) var(--space-4)' }}>
              {corners}
              <div className="card-kicker">{b.name}{b.paid ? '' : ' · unpaid'}</div>
              {b.unlimited ? (
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 30 }}>{b.taken} <span className="text-muted" style={{ fontSize: 14 }}>taken</span></div>
              ) : (
                <>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 34, lineHeight: 1.1 }}>
                    {b.remaining} <span className="text-muted" style={{ fontSize: 14 }}>left of {Math.round((b.entitled + b.carried) * 100) / 100} days</span>
                  </div>
                  <div style={{ height: 6, border: '1px solid var(--color-accent)', margin: '6px 0' }}>
                    <div style={{ height: '100%', width: `${b.entitled + b.carried > 0 ? Math.min(100, ((b.taken + b.pending) / (b.entitled + b.carried)) * 100) : 0}%`, background: 'var(--color-accent)', opacity: 0.55 }} />
                  </div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {b.taken} taken{b.pending ? ` · ${b.pending} waiting` : ''}{b.carried ? ` · ${b.carried} carried over` : ''}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="seg" role="radiogroup" aria-label="Status" style={{ maxWidth: 520 }}>
        {(['all', 'Pending', 'Approved', 'Rejected'] as const).map((f) => (
          <label key={f} className={'seg-opt' + (filter === f ? ' checked' : '')}>
            <input type="radio" name="hrfilter" checked={filter === f} onChange={() => setFilter(f)} />
            {f === 'all' ? 'All' : f}
          </label>
        ))}
      </div>
      {decide.error && <p className="note" role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{decide.error}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              {cfg.canManage && <th>Staff</th>}
              <th>Type</th>
              <th>Dates</th>
              <th style={numStyle}>Days</th>
              <th>Status</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const mine = r.staffId === cfg.me.id;
              return (
                <tr key={r.id}>
                  {cfg.canManage && (
                    <td>
                      <b>{r.staffName}</b>
                      <div className="text-muted" style={{ fontSize: 12 }}>{r.role}</div>
                    </td>
                  )}
                  <td>{r.type}</td>
                  <td>{r.label}</td>
                  <td style={numStyle}>{r.days}</td>
                  <td>{statusTag(r.status)}</td>
                  <td className="text-muted" style={{ fontSize: 13 }}>
                    {r.status === 'Rejected' || r.decisionNote ? r.decisionNote : r.reason}
                    {r.status === 'Approved' && r.decidedByName ? ` · approved by ${r.decidedByName}` : ''}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.status === 'Pending' && cfg.canManage && !mine && (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={decide.busy} onClick={() => decide.reject(r.id)}>Reject</button>{' '}
                        <button type="button" className="btn btn-primary btn-sm" disabled={decide.busy} onClick={() => decide.approve(r.id)}>Approve</button>{' '}
                      </>
                    )}
                    {(r.status === 'Pending' && (mine || cfg.canManage)) || (r.status === 'Approved' && cfg.canManage) ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={decide.busy} onClick={() => decide.cancel(r.id)}>
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className="note">No leave requests{filter === 'all' ? '' : ` that are ${filter.toLowerCase()}`}.</p>}
      </div>
    </>
  );
}

// ── Off-day calendar ─────────────────────────────────────────────────────────────────────────────
function CalendarTab({ version, canManage }: { version: number; canManage: boolean }) {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [d, setD] = useState<{ days: CalDay[]; minCover: number; staffTotal: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setD(null);
    api.get<{ days: CalDay[]; minCover: number; staffTotal: number }>(`/hr/calendar?month=${month}`).then(setD).catch((e) => setErr(errMsg(e)));
  }, [month, version]);
  const pad = d ? WEEKDAY_NO.indexOf(d.days[0]!.weekday) : 0;
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonth(shiftMonth(month, -1))}>← {monthName(shiftMonth(month, -1)).split(' ')[0]}</button>
        <b style={{ fontFamily: 'var(--font-heading)', fontSize: 24, minWidth: 190, textAlign: 'center' }}>{monthName(month)}</b>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonth(shiftMonth(month, 1))}>{monthName(shiftMonth(month, 1)).split(' ')[0]} →</button>
        <input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 170 }} aria-label="Go to month" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMonth(todayStr().slice(0, 7))}>This month</button>
      </div>
      <div className="note" style={{ margin: 0, display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, background: 'var(--color-accent)', opacity: 0.45, marginRight: 6 }} />approved leave</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, border: '1px dashed var(--color-accent)', marginRight: 6 }} />waiting for a decision</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, background: 'var(--color-divider)', marginRight: 6 }} />weekly day off or public / company off day</span>
        <span>{d && d.minCover > 0 ? 'a red day is below the minimum at work' : 'three or more away shade the day'}</span>
      </div>
      {!d ? (
        <p className="note">{err || 'Loading…'}</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', border: '1px solid var(--color-divider)' }}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="card-kicker" style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-divider)' }}>{w}</div>
          ))}
          {Array.from({ length: pad }, (_, i) => (
            <div key={'b' + i} style={{ minHeight: 92, borderRight: '1px solid var(--color-divider)', borderBottom: '1px solid var(--color-divider)' }} />
          ))}
          {d.days.map((day) => (
            <div
              key={day.date}
              style={{
                minHeight: 92,
                padding: '6px 8px',
                borderRight: '1px solid var(--color-divider)',
                borderBottom: '1px solid var(--color-divider)',
                background: day.off ? 'var(--color-divider)' : day.belowCover ? 'rgba(200,60,50,.16)' : day.away >= 3 ? 'var(--color-surface)' : 'transparent',
              }}
              title={day.belowCover ? `Only ${day.atWork} at work (minimum ${d.minCover})` : undefined}
            >
              <div style={{ fontWeight: 700 }}>{Number(day.date.slice(8))}</div>
              {day.off && <div className="text-muted" style={{ fontSize: 11 }}>{day.name ?? 'Weekly day off'}</div>}
              {day.people.map((p) => (
                <div
                  key={p.requestId}
                  style={{ fontSize: 12, margin: '2px 0', padding: '1px 4px', border: `1px ${p.status === 'Approved' ? 'solid' : 'dashed'} var(--color-accent)`, background: p.status === 'Approved' ? 'rgba(89,128,166,.25)' : 'transparent', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={`${p.name} · ${p.type} · ${p.status.toLowerCase()}`}
                >
                  {p.name.split(' ')[0]}{canManage || p.type !== 'Leave' ? ` · ${p.type.replace(' leave', '')}` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Performance ──────────────────────────────────────────────────────────────────────────────────
function PerformanceTab({ cfg }: { cfg: Config }) {
  const [period, setPeriod] = useState(quarterOf(todayStr()));
  const [data, setData] = useState<{ period: string; rows: PerfRow[] } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState({ goalsMet: '0', goalsTotal: '0', rating: '', note: '', status: 'Draft' as 'Draft' | 'Done' });
  const [notes, setNotes] = useState<{ id: number; date: string; note: string; authorName: string }[]>([]);
  const [noteText, setNoteText] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const year = Number(todayStr().slice(0, 4));
  const periods = [-1, 0].flatMap((dy) => [4, 3, 2, 1].map((q) => `${year + dy}-Q${q}`));

  const load = useCallback(() => {
    api.get<{ period: string; rows: PerfRow[] }>(`/hr/performance?period=${period}`).then((d) => {
      setData(d);
      setSel((s) => s ?? d.rows[0]?.staffId ?? null);
    }).catch((e) => setErr(errMsg(e)));
  }, [period]);
  useEffect(load, [load]);

  const row = data?.rows.find((r) => r.staffId === sel) ?? null;
  useEffect(() => {
    if (!row) return;
    setForm({ goalsMet: String(row.review?.goalsMet ?? 0), goalsTotal: String(row.review?.goalsTotal ?? 0), rating: row.review?.rating != null ? String(row.review.rating) : '', note: row.review?.note ?? '', status: row.review?.status ?? 'Draft' });
    setErr('');
    api.get<typeof notes>(`/hr/notes?staffId=${row.staffId}`).then(setNotes).catch(() => setNotes([]));
  }, [row?.staffId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(status: 'Draft' | 'Done') {
    if (!row) return;
    setBusy(true);
    setErr('');
    try {
      await api.put(`/hr/performance/${row.staffId}`, { period, goalsMet: Number(form.goalsMet) || 0, goalsTotal: Number(form.goalsTotal) || 0, rating: form.rating.trim() === '' ? null : Number(form.rating), note: form.note, status });
      load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function addNote() {
    if (!row || noteText.trim().length < 3) return;
    setBusy(true);
    try {
      await api.post('/hr/notes', { staffId: row.staffId, date: todayStr(), note: noteText.trim() });
      setNoteText('');
      setAdding(false);
      setNotes(await api.get<typeof notes>(`/hr/notes?staffId=${row.staffId}`));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;
  const bar = (pct: number | null) => (
    <div style={{ height: 6, border: '1px solid var(--color-accent)' }}>
      <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: 'var(--color-accent)', opacity: 0.55 }} />
    </div>
  );
  void cfg;
  return (
    <>
      <div className="field" style={{ margin: 0, maxWidth: 200 }}>
        <label>Review period</label>
        <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>{p.replace('-', ' ')}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-4)', alignItems: 'start' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Staff</th>
                <th style={numStyle}>Sales</th>
                <th style={numStyle}>vs target</th>
                <th style={numStyle}>Orders</th>
                <th style={numStyle}>Goals</th>
                <th style={numStyle}>Score</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.staffId} onClick={() => setSel(r.staffId)} style={{ cursor: 'pointer', background: sel === r.staffId ? 'var(--color-surface)' : undefined }}>
                  <td>
                    <b>{r.name}</b>
                    <div className="text-muted" style={{ fontSize: 12 }}>{r.role}</div>
                  </td>
                  <td style={numStyle}>{r.sales != null ? fmtKsh(r.sales) : '—'}</td>
                  <td style={numStyle}>{r.salesVsTarget != null ? `${r.salesVsTarget}%` : '—'}</td>
                  <td style={numStyle}>{r.orders ?? '—'}</td>
                  <td style={numStyle}>{r.review ? `${r.review.goalsMet}/${r.review.goalsTotal}` : '—'}</td>
                  <td style={{ ...numStyle, fontFamily: 'var(--font-heading)', fontSize: 22 }}>{r.review?.rating != null ? r.review.rating : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {row && (
          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            {corners}
            <div className="card-kicker">{period.replace('-', ' ')} review</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 30, lineHeight: 1.1 }}>{row.name}</div>
            <div className="text-muted" style={{ fontSize: 13, marginBottom: 'var(--space-3)' }}>{row.role}{row.hireDate ? ` · since ${fmtDate(row.hireDate)}` : ''}</div>
            {[
              ['Sales vs target', row.salesVsTarget != null ? `${row.salesVsTarget}%` : 'no target', row.salesVsTarget],
              ['Goals met', form.goalsTotal !== '0' ? `${form.goalsMet} of ${form.goalsTotal}` : '—', Number(form.goalsTotal) > 0 ? (Number(form.goalsMet) / Number(form.goalsTotal)) * 100 : null],
              ['Orders captured', row.orders != null ? String(row.orders) : '—', null],
              ['Leave taken', `${row.leaveDays} day${row.leaveDays === 1 ? '' : 's'}`, null],
            ].map(([label, value, pct]) => (
              <div key={label as string} style={{ margin: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{label}</span><b>{value}</b></div>
                {pct != null && bar(pct as number)}
              </div>
            ))}
            {row.commission != null && <p className="note" style={{ margin: '4px 0' }}>Sales, orders and commission come from the books for the quarter (Commission). Commission earned: {fmtKsh(row.commission)}.</p>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Goals met</label>
                <input className="input" inputMode="numeric" value={form.goalsMet} onChange={(e) => setForm({ ...form, goalsMet: e.target.value.replace(/\D/g, '') })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Goals set</label>
                <input className="input" inputMode="numeric" value={form.goalsTotal} onChange={(e) => setForm({ ...form, goalsTotal: e.target.value.replace(/\D/g, '') })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Score (0–100)</label>
                <input className="input" inputMode="decimal" value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })} />
              </div>
            </div>
            <div className="field" style={{ margin: 'var(--space-2) 0' }}>
              <label>Manager note</label>
              <textarea className="input" rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setAdding(!adding)}>Add 1:1 note</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => save('Draft')}>Save draft</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save('Done')}>{row.review?.status === 'Done' ? 'Update review' : 'Complete review'}</button>
            </div>
            {row.review && <p className="note">{row.review.status === 'Done' ? 'Completed' : 'Draft'} by {row.review.reviewerName}.</p>}
            {adding && (
              <div style={{ marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-2)' }}>
                <input className="input" style={{ flex: 1 }} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="What was talked about" />
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || noteText.trim().length < 3} onClick={addNote}>Save note</button>
              </div>
            )}
            {notes.length > 0 && (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <div className="card-kicker">One-to-one notes</div>
                {notes.slice(0, 6).map((n) => (
                  <div key={n.id} style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--color-divider)' }}>
                    <span className="text-muted">{fmtDate(n.date)} · {n.authorName}</span>
                    <div>{n.note}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Policy: the kinds of leave, the minimum at work, days off, start dates ──────────────────────
function PolicyTab({ cfg, reload }: { cfg: Config; reload: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [min, setMin] = useState(String(cfg.settings.minCover));
  const [off, setOff] = useState<number[]>(cfg.settings.offWeekdays);
  const [newOff, setNewOff] = useState({ date: '', name: '' });
  const [newType, setNewType] = useState({ name: '', paid: true, daysPerYear: '0', accrual: 'upfront' as 'monthly' | 'upfront', carryOverCap: '0', certAfterDays: '0' });
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const saveType = (t: LeaveType, patch: Partial<LeaveType>) => run(() => api.put(`/hr/leave-types/${t.id}`, { name: t.name, paid: t.paid, daysPerYear: t.daysPerYear, accrual: t.accrual, carryOverCap: t.carryOverCap, certAfterDays: t.certAfterDays, active: t.active, ...patch }));
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const year = Number(todayStr().slice(0, 4));
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {err && <p className="note" role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</p>}
      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Kinds of leave</div>
        <p className="note" style={{ marginTop: 0 }}>The yearly allowance (0 = no limit). Annual leave is earned a month at a time; the others are there from the start of the year. The figures that come with the system are the Employment Act's minimums: change them to your policy.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Paid</th>
                <th>Days a year</th>
                <th>Earned</th>
                <th>Carry over up to</th>
                <th>Certificate past</th>
                <th>In use</th>
              </tr>
            </thead>
            <tbody>
              {cfg.leaveTypes.map((t) => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                  <td>{t.name}</td>
                  <td><input type="checkbox" checked={t.paid} onChange={(e) => saveType(t, { paid: e.target.checked })} disabled={busy} /></td>
                  <td><input className="input" style={{ width: 80 }} inputMode="decimal" defaultValue={t.daysPerYear} onBlur={(e) => num(e.target.value) !== t.daysPerYear && saveType(t, { daysPerYear: num(e.target.value) })} /></td>
                  <td>
                    <select className="input" value={t.accrual} onChange={(e) => saveType(t, { accrual: e.target.value as 'monthly' | 'upfront' })} disabled={busy}>
                      <option value="monthly">a month at a time</option>
                      <option value="upfront">from January</option>
                    </select>
                  </td>
                  <td><input className="input" style={{ width: 80 }} inputMode="decimal" defaultValue={t.carryOverCap} onBlur={(e) => num(e.target.value) !== t.carryOverCap && saveType(t, { carryOverCap: num(e.target.value) })} /></td>
                  <td><input className="input" style={{ width: 80 }} inputMode="numeric" defaultValue={t.certAfterDays} onBlur={(e) => num(e.target.value) !== t.certAfterDays && saveType(t, { certAfterDays: Math.round(num(e.target.value)) })} /> <span className="text-muted" style={{ fontSize: 12 }}>days</span></td>
                  <td><input type="checkbox" checked={t.active} onChange={(e) => saveType(t, { active: e.target.checked })} disabled={busy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end', marginTop: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Add a kind of leave</label>
            <input className="input" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} placeholder="e.g. Compassionate leave" />
          </div>
          <div className="field" style={{ margin: 0, width: 110 }}>
            <label>Days a year</label>
            <input className="input" inputMode="decimal" value={newType.daysPerYear} onChange={(e) => setNewType({ ...newType, daysPerYear: e.target.value })} />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
            <input type="checkbox" checked={newType.paid} onChange={(e) => setNewType({ ...newType, paid: e.target.checked })} /> paid
          </label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || newType.name.trim().length < 2} onClick={() => run(async () => { await api.post('/hr/leave-types', { name: newType.name, paid: newType.paid, daysPerYear: num(newType.daysPerYear), accrual: newType.accrual, carryOverCap: num(newType.carryOverCap), certAfterDays: Math.round(num(newType.certAfterDays)), active: true }); setNewType({ ...newType, name: '', daysPerYear: '0' }); })}>
            Add
          </button>
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Working week and cover</div>
        <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', alignItems: 'end' }}>
          <div>
            <div className="card-kicker">Weekly days off</div>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              {WEEKDAYS.map((w, i) => (
                <label key={w} style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400 }}>
                  <input type="checkbox" checked={off.includes(WEEKDAY_NO[i]!)} onChange={(e) => setOff(e.target.checked ? [...off, WEEKDAY_NO[i]!] : off.filter((x) => x !== WEEKDAY_NO[i]))} /> {w}
                </label>
              ))}
            </div>
          </div>
          <div className="field" style={{ margin: 0, width: 190 }}>
            <label>Fewest people at work (0 = no minimum)</label>
            <input className="input" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api.put('/hr/settings', { minCover: Number(min) || 0, offWeekdays: off }))}>Save</button>
        </div>
        <p className="note" style={{ marginBottom: 0 }}>A leave uses working days only: the weekly days off and the off days below are not counted. When approving would leave fewer people at work than the minimum, the decider is asked to confirm.</p>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Public holidays and company off days</div>
        <p className="note" style={{ marginTop: 0 }}>The fixed-date Kenyan public holidays are added for you (one that falls on a Sunday moves to the Monday). Add the ones that move each year, such as Good Friday, Easter Monday and Idd-ul-Fitr, and any company off day.</p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Date</label>
            <input className="input" type="date" value={newOff.date} onChange={(e) => setNewOff({ ...newOff, date: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0, flex: '1 1 220px' }}>
            <label>Name</label>
            <input className="input" value={newOff.name} onChange={(e) => setNewOff({ ...newOff, name: e.target.value })} placeholder="e.g. Good Friday" />
          </div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !newOff.date || newOff.name.trim().length < 2} onClick={() => run(async () => { await api.post('/hr/off-days', newOff); setNewOff({ date: '', name: '' }); })}>Add</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px var(--space-4)' }}>
          {cfg.offDays.filter((o) => o.date >= `${year}-01-01`).map((o) => (
            <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--color-divider)' }}>
              <span>{dateSpanLabel(o.date, o.date)} · {o.name}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.del(`/hr/off-days/${o.id}`))}>Remove</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        {corners}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Start dates</div>
        <p className="note" style={{ marginTop: 0 }}>Annual leave is earned from the month a person started. Someone with no start date is treated as having worked the whole year.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {cfg.staff.map((s) => (
                <Fragment key={s.id}>
                  <tr>
                    <td>{s.name} <span className="text-muted" style={{ fontSize: 12 }}>{s.role}</span></td>
                    <td style={{ width: 190 }}>
                      <input className="input" type="date" defaultValue={s.hireDate ?? ''} onBlur={(e) => (e.target.value || null) !== (s.hireDate ?? null) && run(() => api.put(`/hr/staff/${s.id}/hire-date`, { hireDate: e.target.value || null }))} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── New leave request ────────────────────────────────────────────────────────────────────────────
function NewRequestDialog({ cfg, onClose, onDone }: { cfg: Config; onClose: () => void; onDone: () => void }) {
  const types = cfg.leaveTypes.filter((t) => t.active);
  const [staffId, setStaffId] = useState(cfg.me.id);
  const [typeId, setTypeId] = useState(types[0]?.id ?? 0);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [reason, setReason] = useState('');
  const [cert, setCert] = useState(false);
  const [bal, setBal] = useState<Balance[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const type = types.find((t) => t.id === typeId);
  const offDates = useMemo(() => new Set(cfg.offDays.map((o) => o.date)), [cfg.offDays]);
  const days = from && to && to >= from && dateRange(from, to).length <= 400 ? leaveWorkingDays(from, to, cfg.settings.offWeekdays, offDates) : [];
  const year = Number((from || todayStr()).slice(0, 4));
  useEffect(() => {
    api.get<{ balances: Balance[] }>(`/hr/balances?staffId=${staffId}&year=${year}`).then((r) => setBal(r.balances)).catch(() => setBal([]));
  }, [staffId, year]);
  const b = bal.find((x) => x.typeId === typeId);
  const needsCert = !!type && type.certAfterDays > 0 && days.length > type.certAfterDays;
  const problem = to < from ? 'The last day cannot be before the first day' : days.length === 0 ? 'Those dates are all days off, so there is no leave to take' : b && !b.unlimited && days.length > b.available + 0.001 ? `Only ${b.available} day${b.available === 1 ? '' : 's'} available` : needsCert && !cert ? 'Tick that a medical certificate is provided' : '';

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await api.post('/hr/requests', { staffId, leaveTypeId: typeId, startDate: from, endDate: to, reason, certificate: cert });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 440, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
        {corners}
        <div className="dialog-title">New leave request</div>
        <div className="dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {cfg.canManage && (
            <div className="field" style={{ margin: 0 }}>
              <label>Staff</label>
              <select className="input" value={staffId} onChange={(e) => setStaffId(Number(e.target.value))}>
                {cfg.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.id === cfg.me.id ? ' (me)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>Type</label>
            <div className="seg" role="radiogroup" aria-label="Type" style={{ flexWrap: 'wrap' }}>
              {types.map((t) => (
                <label key={t.id} className={'seg-opt' + (typeId === t.id ? ' checked' : '')}>
                  <input type="radio" name="hrtype" checked={typeId === t.id} onChange={() => setTypeId(t.id)} />
                  {t.name.replace(' leave', '')}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {needsCert && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
              <input type="checkbox" checked={cert} onChange={(e) => setCert(e.target.checked)} /> A medical certificate is provided (needed past {type!.certAfterDays} day{type!.certAfterDays === 1 ? '' : 's'})
            </label>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>Note (optional)</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <p className="note" style={{ margin: 0, borderLeft: `2px solid ${problem ? 'var(--color-error)' : 'var(--color-accent)'}`, paddingLeft: 'var(--space-2)' }}>
            {problem ? problem : `${days.length} working day${days.length === 1 ? '' : 's'}${b && !b.unlimited ? ` · balance after: ${Math.round((b.available - days.length) * 100) / 100}` : ''}.`}
          </p>
          {err && <p className="note" role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !!problem || !typeId}>Submit</button>
        </div>
      </div>
    </div>
  );
}
