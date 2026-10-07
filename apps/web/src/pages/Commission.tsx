import { Fragment, useEffect, useState } from 'react';
import { EXPENSE_METHODS, bandsProblem, fmtDate, fmtKsh, fmtNum } from '@glm/shared';
import type { Band } from '@glm/shared';
import { api } from '../api/client';
import { useSubTab } from '../state/SubNavContext';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from './accounting/shared';

// Sales commission. Everyone who captures orders sees their own month: what they earned, how, and what they have sold. Managers also
// see the whole team, approve and pay the month, manage which client belongs to whom, and set the rates.
//
// Commission is earned on money RECEIVED in the month — not on orders raised — and on net sales (VAT out).

interface Config {
  generalBands: Band[];
  filmBands: Band[];
  artworkRatePct: number;
  ownershipMonths: number;
  /** Times their basic monthly salary a person must sell before commission starts (0 = no target). */
  targetMultiplier: number;
  targetMode: 'above' | 'all';
}
interface Target {
  applies: boolean;
  multiplier: number;
  mode: 'above' | 'all';
  salary: number | null;
  salaryKnown: boolean;
  required: number;
  achieved: number;
  met: boolean;
  remaining: number;
  eligibleSales: number;
  held: boolean;
}
interface Statement {
  staffId: number;
  staffName: string;
  total: number;
  target: Target;
  /** Earned on the month's sales but held back until the target is met. */
  heldCommission: number;
  general: {
    received: number;
    netSales: number;
    commission: number;
    band: { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null };
    orders: { orderNo: string; customer: string; received: number; refunded: number }[];
  };
  film: { commission: number; sales: { orderNo: string; customer: string; metres: number; pricePerM: number; premiumPerM: number; orderTotal: number; moneyIn: number; commission: number }[] };
  artwork: { commission: number; jobs: { orderNo: string; customer: string; pieces: number; systemPerPiece: number; chargedPerPiece: number; orderTotal: number; moneyIn: number; commission: number }[] };
  productivity: {
    ordersCaptured: number;
    ordersSourced: number;
    sourcedValue: number;
    filmSales: number;
    filmMetres: number;
    filmAvgPricePerM: number | null;
    filmAvgPremiumPerM: number | null;
    artworkJobs: number;
    artworkPieces: number;
    artworkExtraCharged: number;
  };
}
interface Payout {
  id: number;
  status: string;
  amount: number;
  paidOn: string | null;
  paidMethod: string | null;
}
interface MyData {
  period: string;
  config: Config;
  statement: Statement;
  payout: { status: string; amount: number; paidOn: string | null } | null;
  clients: { id: number; name: string; startDate: string; endDate: string }[];
}
interface TeamData {
  period: string;
  open: boolean;
  config: Config;
  statements: (Statement & { payout: Payout | null })[];
  totals: { commission: number };
}
interface ClientRow {
  id: number;
  clientKey: string;
  clientName: string;
  staffId: number;
  staffName: string;
  startDate: string;
  endDate: string;
  status: string;
  note: string;
}

type Tab = 'mine' | 'team' | 'clients' | 'rates';
const thisMonth = () => new Date().toISOString().slice(0, 7);
const pct = (n: number) => `${fmtNum(n, 2).replace(/\.?0+$/, '')}%`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', minWidth: 170, flex: '1 1 170px' }}>
      <div className="card-kicker">{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>{value}</div>
      {sub && <div className="note" style={{ margin: 0 }}>{sub}</div>}
    </div>
  );
}

/** Where the person stands against the sales target (3 × basic salary), with a bar. */
function TargetCard({ s, you }: { s: Statement; you?: boolean }) {
  const t = s.target;
  if (!t.applies) return null;
  const who = you ? 'You' : s.staffName;
  const done = t.required > 0 ? Math.min(100, Math.round((t.achieved / t.required) * 100)) : 0;
  return (
    <div>
      <div className="card-kicker">Sales target — {!t.salaryKnown ? 'salary needed' : t.met ? 'met' : `${done}% there`}</div>
      {!t.salaryKnown ? (
        <p className="note" style={{ marginTop: 0, color: '#a33' }}>
          {you ? 'Your' : 'Their'} basic salary has not been recorded, so there is no target to measure and commission is <b>on hold</b>. Finance adds it under Compliance → Employees.
          {s.heldCommission > 0 && <> {fmtKsh(s.heldCommission)} is waiting.</>}
        </p>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Commission starts once {you ? 'you have' : 'they have'} sold {t.multiplier}× {you ? 'your' : 'their'} basic salary of {fmtKsh(t.salary!)} — <b>{fmtKsh(t.required)}</b> in net sales (VAT out) received in the month. {who} {you ? 'have' : 'has'} sold <b>{fmtKsh(t.achieved)}</b>
            {t.met ? (
              <>
                {' '}
                — <b>target met</b>. {t.mode === 'above' ? <>Commission is paid on the {fmtKsh(t.eligibleSales)} sold above the target.</> : <>Commission is paid on all {fmtKsh(t.achieved)} sold.</>}
              </>
            ) : (
              <>
                {' '}
                — <b>{fmtKsh(t.remaining)} to go</b>.{s.heldCommission > 0 && <> {fmtKsh(s.heldCommission)} already earned on film and artwork is held until then.</>}
              </>
            )}
          </p>
          <div style={{ background: 'var(--color-divider)', height: 10, maxWidth: 520 }} aria-label={`${done}% of the sales target`}>
            <div style={{ width: `${done}%`, height: '100%', background: t.met ? 'var(--color-accent)' : 'var(--color-text)' }} />
          </div>
        </>
      )}
    </div>
  );
}

/** How a month's figure was made up — shown to the staff member themselves and to managers. */
function StatementDetail({ s, config, you }: { s: Statement; config: Config; you?: boolean }) {
  const p = s.productivity;
  const who = you ? 'you' : s.staffName;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <TargetCard s={s} you={you} />
      <div>
        <div className="card-kicker">Sales {you ? 'you' : 'they'} sourced — {fmtKsh(s.general.commission)}</div>
        <p className="note" style={{ marginTop: 0 }}>
          Money received this month on orders credited to {who}: {fmtKsh(s.general.received)} (VAT included) = <b>{fmtKsh(s.general.netSales)}</b> net. {you ? 'You are' : s.staffName + ' is'} in the <b>{pct(s.general.band.rate)}</b> band
          {s.general.band.toNext != null && s.general.band.nextRate != null && (
            <>
              {' '}
              — {fmtKsh(s.general.band.toNext)} more in net sales takes the next slice to {pct(s.general.band.nextRate)}
            </>
          )}
          .
        </p>
        {s.general.orders.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th style={numStyle}>Received</th>
                <th style={numStyle}>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {s.general.orders.map((o) => (
                <tr key={o.orderNo}>
                  <td>{o.orderNo}</td>
                  <td>{o.customer}</td>
                  <td style={numStyle}>{fmtKsh(o.received)}</td>
                  <td style={numStyle}>{o.refunded > 0 ? fmtKsh(o.refunded) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </div>

      <div>
        <div className="card-kicker">DTF film sold above the base price — {fmtKsh(s.film.commission)}</div>
        {s.film.sales.length === 0 ? (
          <p className="note" style={{ marginTop: 0 }}>No film sold above the base price has been paid for this month.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th style={numStyle}>Metres</th>
                <th style={numStyle}>Price / m</th>
                <th style={numStyle}>Above base / m</th>
                <th style={numStyle}>Paid so far</th>
                <th style={numStyle}>Commission</th>
              </tr>
            </thead>
            <tbody>
              {s.film.sales.map((x) => (
                <tr key={x.orderNo}>
                  <td>{x.orderNo}</td>
                  <td>{x.customer}</td>
                  <td style={numStyle}>{fmtNum(x.metres, 2)}</td>
                  <td style={numStyle}>{fmtNum(x.pricePerM)}</td>
                  <td style={numStyle}>{fmtNum(x.premiumPerM)}</td>
                  <td style={numStyle}>{fmtKsh(x.moneyIn)} of {fmtKsh(x.orderTotal)}</td>
                  <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(x.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </div>

      <div>
        <div className="card-kicker">Artwork charged above the recommended price — {fmtKsh(s.artwork.commission)}</div>
        {s.artwork.jobs.length === 0 ? (
          <p className="note" style={{ marginTop: 0 }}>No artwork job charged above the recommended price has been paid for this month. You earn {pct(config.artworkRatePct)} of the amount above the recommended price.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th style={numStyle}>Pieces</th>
                <th style={numStyle}>Recommended</th>
                <th style={numStyle}>Charged</th>
                <th style={numStyle}>Paid so far</th>
                <th style={numStyle}>Commission</th>
              </tr>
            </thead>
            <tbody>
              {s.artwork.jobs.map((x) => (
                <tr key={x.orderNo}>
                  <td>{x.orderNo}</td>
                  <td>{x.customer}</td>
                  <td style={numStyle}>{fmtNum(x.pieces)}</td>
                  <td style={numStyle}>{fmtNum(x.systemPerPiece, 2)}</td>
                  <td style={numStyle}>{fmtNum(x.chargedPerPiece, 2)}</td>
                  <td style={numStyle}>{fmtKsh(x.moneyIn)} of {fmtKsh(x.orderTotal)}</td>
                  <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(x.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </div>

      <div>
        <div className="card-kicker">What was sold this month (paid or not)</div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Stat label="Orders captured" value={fmtNum(p.ordersCaptured)} />
          <Stat label={you ? 'Orders from your clients' : 'Orders from their clients'} value={fmtNum(p.ordersSourced)} sub={fmtKsh(p.sourcedValue)} />
          <Stat label="Film sold" value={`${fmtNum(p.filmMetres, 1)} m`} sub={p.filmAvgPricePerM != null ? `avg ${fmtNum(p.filmAvgPricePerM, 0)}/m · ${fmtNum(p.filmAvgPremiumPerM ?? 0, 0)} above base` : `${p.filmSales} sales`} />
          <Stat label="Artwork jobs" value={fmtNum(p.artworkJobs)} sub={p.artworkJobs ? `${fmtNum(p.artworkPieces)} pieces · ${fmtKsh(p.artworkExtraCharged)} above recommended` : undefined} />
        </div>
      </div>
    </div>
  );
}

function SchemeNote({ config }: { config: Config }) {
  return (
    <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
      {config.targetMultiplier > 0 && (
        <li>
          <b>Sales target first:</b> no commission is earned in a month until your net sales received reach <b>{config.targetMultiplier}× your basic monthly salary</b>.{' '}
          {config.targetMode === 'above' ? 'The bands below then start at the target — only what you sell above it earns.' : 'Once it is met, the bands below apply to all of your sales.'} Film and artwork extras are paid in full once the target is met. Prices are never relaxed to help reach it: the minimum prices at order taking stay as they are.
        </li>
      )}
      <li>
        <b>Sales you source:</b> a percentage of the net sales (VAT out) <i>received</i> in the month from clients credited to you, in bands —{' '}
        {config.generalBands.map((b, i) => `${i === 0 ? 'up to ' : ''}${i === 0 && config.generalBands[1] ? fmtKsh(config.generalBands[1].from) : i > 0 ? `from ${fmtKsh(b.from)}` : ''} at ${pct(b.rate)}`).join(' · ')}. A client you bring in stays yours for {config.ownershipMonths} months.
      </li>
      <li>
        <b>Film:</b> everything you charge above the base price per metre earns a share of that extra, with no ceiling —{' '}
        {config.filmBands.map((b, i) => `${i === config.filmBands.length - 1 ? `over ${b.from}` : `${b.from}–${config.filmBands[i + 1]!.from}`} above base: ${pct(b.rate)}`).join(' · ')}.
      </li>
      <li>
        <b>Artwork:</b> you may charge more than the system’s recommended price; you earn {pct(config.artworkRatePct)} of the amount above it, and nothing on the recommended price itself.
      </li>
      <li>Film and artwork commission is earned as the customer pays — a half-paid order earns half.</li>
    </ul>
  );
}

// ── My commission ───────────────────────────────────────────────────────────
function MyTab({ period }: { period: string }) {
  const { data, error, loading } = useLoad<MyData>(`/commission/my?period=${period}`);
  if (!data) return <Loading loading={loading} error={error} />;
  const s = data.statement;
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Stat label="Your commission" value={fmtKsh(s.total)} sub={data.payout ? `${data.payout.status}${data.payout.paidOn ? ' on ' + fmtDate(data.payout.paidOn) : ''}` : 'not yet approved'} />
        <Stat label="Sales you sourced" value={fmtKsh(s.general.commission)} sub={s.target.held ? `${fmtKsh(s.general.netSales)} net received · below your sales target` : `${fmtKsh(s.general.netSales)} net received · ${pct(s.general.band.rate)} band`} />
        <Stat label="Film" value={fmtKsh(s.film.commission)} />
        <Stat label="Artwork" value={fmtKsh(s.artwork.commission)} />
      </div>
      {s.target.applies && (
        <Card title="Your sales target" hint="Sell this much in the month and commission starts.">
          <TargetCard s={s} you />
        </Card>
      )}
      <Card title="How you earn" hint="The scheme as it stands today.">
        <SchemeNote config={data.config} />
      </Card>
      <Card title="This month in detail">
        <StatementDetail s={s} config={data.config} you />
      </Card>
      <Card title="Clients credited to you" hint="Every order from these clients counts towards your commission until the date shown.">
        {data.clients.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>None yet. Tick “brought this client in” when you capture a new client’s order.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Since</th>
                <th>Credited until</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="text-muted">{fmtDate(c.startDate)}</td>
                  <td>{fmtDate(c.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </Card>
    </>
  );
}

// ── Team & payouts ──────────────────────────────────────────────────────────
function TeamTab({ period }: { period: string }) {
  const { data, error, loading, reload } = useLoad<TeamData>(`/commission/statement?period=${period}`);
  const [open, setOpen] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof EXPENSE_METHODS)[number]>('Bank Transfer');
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
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Loading loading={loading} error={error} />;
  const approvable = data.statements.some((s) => s.total > 0 && s.payout?.status !== 'Paid');

  return (
    <>
      <Notice error={err} message={msg} />
      {data.open && <p className="note">This month is not over, so more money may still come in. Approve it once the month has closed.</p>}
      <Card
        title={`Commission for ${period}`}
        hint={`${fmtKsh(data.totals.commission)} in total, on money received this month.`}
        actions={
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !approvable} onClick={() => run(async () => { await api.post('/commission/payouts/approve', { period }); return `Commission for ${period} approved`; })}>
            Approve month
          </button>
        }
      >
        {data.statements.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>Nothing has been earned this month yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Staff</th>
                <th style={numStyle}>Net sales received</th>
                <th>Sales target</th>
                <th style={numStyle}>Sourced sales</th>
                <th style={numStyle}>Film</th>
                <th style={numStyle}>Artwork</th>
                <th style={numStyle}>Total</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {data.statements.map((s) => (
                <Fragment key={s.staffId}>
                  <tr>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === s.staffId ? null : s.staffId)}>
                        {open === s.staffId ? '▾' : '▸'} {s.staffName}
                      </button>
                    </td>
                    <td style={numStyle}>{fmtKsh(s.target.achieved)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!s.target.applies ? (
                        <span className="text-muted">—</span>
                      ) : !s.target.salaryKnown ? (
                        <Tag tone="bad">salary needed</Tag>
                      ) : s.target.met ? (
                        <Tag tone="good">met · {fmtKsh(s.target.required)}</Tag>
                      ) : (
                        <span title={s.heldCommission > 0 ? `${fmtKsh(s.heldCommission)} held until the target is met` : undefined}>{fmtKsh(s.target.remaining)} to go of {fmtKsh(s.target.required)}</span>
                      )}
                    </td>
                    <td style={numStyle}>{fmtKsh(s.general.commission)}</td>
                    <td style={numStyle}>{fmtKsh(s.film.commission)}</td>
                    <td style={numStyle}>{fmtKsh(s.artwork.commission)}</td>
                    <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(s.total)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!s.payout && s.total > 0 && <Tag>not approved</Tag>}
                      {s.payout?.status === 'Approved' && (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <Tag tone="bad">approved</Tag>
                          <select className="input" style={{ width: 130 }} value={method} onChange={(e) => setMethod(e.target.value as (typeof EXPENSE_METHODS)[number])}>
                            {EXPENSE_METHODS.map((m) => (
                              <option key={m}>{m}</option>
                            ))}
                          </select>
                          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/commission/payouts/${s.payout!.id}/pay`, { method }); return `${s.staffName} paid ${fmtKsh(s.payout!.amount)} by ${method}`; })}>
                            Mark paid
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.del(`/commission/payouts/${s.payout!.id}`); return 'Approval withdrawn'; })}>
                            Withdraw
                          </button>
                        </span>
                      )}
                      {s.payout?.status === 'Paid' && <Tag tone="good">paid {s.payout.paidOn ? fmtDate(s.payout.paidOn) : ''} · {s.payout.paidMethod}</Tag>}
                    </td>
                  </tr>
                  {open === s.staffId && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--color-surface-2, transparent)' }}>
                        <div style={{ padding: 'var(--space-3)' }}>
                          <StatementDetail s={s} config={data.config} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
</div>
        )}
        <p className="note">Paying records an expense under Sales Commission, so it reaches the books (and the petty-cash float when paid from petty cash).</p>
      </Card>
    </>
  );
}

// ── Clients ─────────────────────────────────────────────────────────────────
function ClientsTab() {
  const { staff, corporateClients } = useCatalog();
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useLoad<ClientRow[]>(`/commission/clients?status=${all ? 'all' : 'active'}`);
  const [form, setForm] = useState({ staffId: '', corporateClientId: '', name: '', phone: '', startDate: '' });
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
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const assign = () =>
    run(async () => {
      await api.post('/commission/clients', {
        staffId: Number(form.staffId),
        corporateClientId: form.corporateClientId ? Number(form.corporateClientId) : undefined,
        name: form.name.trim() || undefined,
        phone: form.phone.trim() || undefined,
        startDate: form.startDate || undefined,
      });
      setForm({ staffId: form.staffId, corporateClientId: '', name: '', phone: '', startDate: '' });
      return 'Client credited';
    });

  return (
    <>
      <Notice error={err} message={msg} />
      <Card title="Credit a client to a staff member" hint="For clients someone brought in before this was tracked. A client belongs to one person at a time — release them first to hand them on.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Staff member</label>
            <select className="input" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
              <option value="">Choose…</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Corporate client</label>
            <select className="input" value={form.corporateClientId} onChange={(e) => setForm({ ...form, corporateClientId: e.target.value })}>
              <option value="">— or a walk-in client —</option>
              {corporateClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Client name</label>
            <input className="input" value={form.name} disabled={!!form.corporateClientId} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Client phone</label>
            <input className="input" value={form.phone} disabled={!!form.corporateClientId} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07xx xxx xxx" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Since (optional)</label>
            <input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !form.staffId || (!form.corporateClientId && !form.phone.trim() && form.name.trim().length < 3)} onClick={assign}>
            Credit client
          </button>
        </div>
      </Card>

      <Card
        title="Clients and who they are credited to"
        actions={
          <label style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> include expired and released
          </label>
        }
      >
        {!data ? (
          <Loading loading={loading} error={error} />
        ) : data.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>No clients are credited to anyone yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
<table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Credited to</th>
                <th>Since</th>
                <th>Until</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td>{c.clientName}</td>
                  <td>{c.staffName}</td>
                  <td className="text-muted">{fmtDate(c.startDate)}</td>
                  <td>{fmtDate(c.endDate)}</td>
                  <td>
                    <Tag tone={c.status === 'Active' ? 'good' : 'neutral'}>{c.status}</Tag>
                  </td>
                  <td>
                    {c.status === 'Active' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/commission/clients/${c.id}/release`, {}); return `${c.clientName} released`; })}>
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </Card>
    </>
  );
}

// ── Rates ───────────────────────────────────────────────────────────────────
function BandEditor({ title, hint, unit, bands, onChange }: { title: string; hint: string; unit: string; bands: { from: string; rate: string }[]; onChange: (b: { from: string; rate: string }[]) => void }) {
  return (
    <div>
      <div className="card-kicker">{title}</div>
      <p className="note" style={{ marginTop: 0 }}>{hint}</p>
      <div style={{ overflowX: 'auto' }}>
<table className="table" style={{ maxWidth: 480 }}>
        <thead>
          <tr>
            <th>From ({unit})</th>
            <th>Pays (%)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              <td>
                <input className="input" inputMode="decimal" value={b.from} disabled={i === 0} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              </td>
              <td>
                <input className="input" inputMode="decimal" value={b.rate} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
              </td>
              <td>{i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(bands.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
</div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...bands, { from: '', rate: '' }])}>
        + Add band
      </button>
    </div>
  );
}

function RatesTab() {
  const { data, error, loading, reload } = useLoad<Config>('/commission/settings');
  const [general, setGeneral] = useState<{ from: string; rate: string }[]>([]);
  const [film, setFilm] = useState<{ from: string; rate: string }[]>([]);
  const [artwork, setArtwork] = useState('');
  const [months, setMonths] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [mode, setMode] = useState<'above' | 'all'>('above');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setGeneral(data.generalBands.map((b) => ({ from: String(b.from), rate: String(b.rate) })));
    setFilm(data.filmBands.map((b) => ({ from: String(b.from), rate: String(b.rate) })));
    setArtwork(String(data.artworkRatePct));
    setMonths(String(data.ownershipMonths));
    setMultiplier(String(data.targetMultiplier));
    setMode(data.targetMode);
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const toBands = (rows: { from: string; rate: string }[]): Band[] => rows.map((r) => ({ from: Number(r.from), rate: Number(r.rate) }));
  const problem = bandsProblem(toBands(general), 'Sales bands') ?? bandsProblem(toBands(film), 'Film bands');

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.put('/commission/settings', { generalBands: toBands(general), filmBands: toBands(film), artworkRatePct: Number(artwork), ownershipMonths: Number(months), targetMultiplier: Number(multiplier), targetMode: mode });
      setMsg('Rates saved — they apply to money received from now on, and to any month not yet approved.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Commission rates" hint="Placeholders to start with — adjust them as you learn what a good month looks like.">
      <Notice error={err} message={msg} />
      <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
        <div>
          <div className="card-kicker">Sales target before commission</div>
          <p className="note" style={{ marginTop: 0 }}>
            A person must sell this many times their basic monthly salary — net of VAT, money received in the month — before they earn any commission. Their salary is kept on their staff record (Compliance → Employees); with no salary recorded, commission is held. For example 3 × a salary of 40,000 = a target of 120,000. Set 0 for no target. Prices at order taking are not affected, so the minimum price rules still stop sales being under-priced to reach a target.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Target = this many × basic salary</label>
              <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Once the target is met, the bands apply to</label>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'above' | 'all')}>
                <option value="above">only the sales above the target</option>
                <option value="all">all of the month's sales</option>
              </select>
            </div>
          </div>
          {mode === 'above' && Number(multiplier) > 0 && <p className="note">With “only the sales above the target”, the first band below starts at the target itself — so a first band of 0 to 150,000 at 0% would mean nothing is paid until 150,000 <i>past</i> the target. Set the first band's rate to what should be paid just past the target.</p>}
        </div>
        <BandEditor
          title="Sales you source"
          hint="Marginal bands on a staff member’s monthly NET sales received from clients credited to them: each rate applies only to the slice of the month that falls inside its band."
          unit="Ksh net per month"
          bands={general}
          onChange={setGeneral}
        />
        <BandEditor
          title="Film sold above the base price"
          hint="Ksh per metre charged above the base price (the DTF minimum price) → the share of that slice that is paid. The last band has no upper limit: there is no ceiling price."
          unit="Ksh/m above base"
          bands={film}
          onChange={setFilm}
        />
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Artwork: % of the amount above the recommended price</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={artwork} onChange={(e) => setArtwork(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>A sourced client stays credited for (months)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>Applies to clients sourced from now on.</p>
          </div>
        </div>
        {problem && <p className="note" style={{ color: '#a33', margin: 0 }}>{problem}</p>}
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!problem || !(Number(artwork) >= 0 && Number(artwork) <= 100) || !(Number(months) >= 1) || !(Number(multiplier) >= 0 && Number(multiplier) <= 20)} onClick={save}>
            Save rates
          </button>
        </div>
      </div>
    </Card>
  );
}

export default function Commission() {
  const { user } = useAuth();
  const manager = user?.role === 'Admin' || !!user?.permissions.canManageCommission;
  const [tab, setTab] = useSubTab<Tab>(manager ? 'team' : 'mine');
  const [period, setPeriod] = useState(thisMonth());

  const tabs: [Tab, string][] = [['mine', 'My commission']];
  if (manager) tabs.push(['team', 'Team & payouts'], ['clients', 'Clients'], ['rates', 'Rates']);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div>
          <div className="card-kicker">Sales</div>
          <div className="card-title">Commission</div>
          <p className="note" style={{ margin: 0 }}>Earned on money received, net of VAT. A month runs from the 1st to the last day.</p>
        </div>
        {(tab === 'mine' || tab === 'team') && (
          <div className="field" style={{ margin: 0 }}>
            <label>Month</label>
            <input className="input" type="month" value={period} max={thisMonth()} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" className={'btn ' + (tab === k ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'mine' && <MyTab period={period} />}
      {tab === 'team' && manager && <TeamTab period={period} />}
      {tab === 'clients' && manager && <ClientsTab />}
      {tab === 'rates' && manager && <RatesTab />}
    </>
  );
}
