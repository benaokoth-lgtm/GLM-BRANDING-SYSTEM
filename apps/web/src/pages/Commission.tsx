import { Fragment, useEffect, useState } from 'react';
import { EXPENSE_METHODS, bandsProblem, fmtDate, fmtKsh, fmtNum, payStepsProblem } from '@glm/shared';
import type { Band } from '@glm/shared';
import { api } from '../api/client';
import { useSubTab } from '../state/SubNavContext';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from './accounting/shared';
import FreelancePanel from '../components/FreelancePanel';

// Sales commission. Everyone who captures orders sees their own month: what they earned, how, and what they have sold. Managers also
// see the whole team, approve and pay the month, manage which client belongs to whom, and set the rates.
//
// Commission is earned on money RECEIVED in the month — not on orders raised — and on net sales (VAT out).

interface Config {
  generalBands: Band[];
  filmBands: Band[];
  artworkRatePct: number;
  ownershipMonths: number;
  /** Freelance sales persons: weekly net sales received at or above base prices → rate. */
  freelanceBands: Band[];
  /** A freelancer keeps a client while an order comes in at least this often (months). */
  freelanceOwnershipMonths: number;
  /** Withholding tax (percent) deducted from freelance commission. */
  freelanceWhtRate: number;
  /** The % of what was charged above base prices that a freelancer keeps. */
  freelancePremiumPct: number;
  /** The weight (%) at which the base part of contracted-out and stock lines counts towards the freelance bands. */
  freelanceLowMarginPct: number;
  /** Times their gross monthly salary a person must sell before commission starts (0 = no target). */
  targetMultiplier: number;
  targetMode: 'above' | 'all';
  /** How general sales are paid: a fixed payout by band ('steps') or a percentage of slices ('percent'). */
  generalMode: 'steps' | 'percent';
  payBands: { from: number; payout: number }[];
  /** Sales below this in a month need performance improvement. */
  performanceFloor: number;
}
interface Scheme {
  mode: 'steps' | 'percent';
  sales: number;
  floor: number;
  belowFloor: boolean;
  step: { index: number; from: number; payout: number; nextFrom: number | null; nextPayout: number | null; toNext: number | null } | null;
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
  scheme: Scheme;
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

interface MonthlyRow {
  staffId: number;
  staffName: string;
  sales: number;
  target: { applies: boolean; required: number; met: boolean; salaryKnown: boolean };
  belowFloor: boolean;
  band: number | null;
  commission: number;
  provisional: boolean;
  paid: number;
  outstanding: number;
  status: 'Paid' | 'Approved' | 'Not approved' | '—';
  paidOn: string | null;
}
interface MonthlyTotals {
  sales: number;
  commission: number;
  paid: number;
  outstanding: number;
}
interface MonthlyData {
  year: string;
  months: { period: string; open: boolean; rows: MonthlyRow[]; totals: MonthlyTotals }[];
  staff: { staffId: number; staffName: string; sales: number; commission: number; paid: number; outstanding: number; monthsTargetMet: number; monthsWithTarget: number }[];
  totals: MonthlyTotals;
}

type Tab = 'mine' | 'team' | 'monthly' | 'clients' | 'freelance' | 'rates';
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

const FLOOR_WARNING = (floor: number) => `Sales below ${fmtKsh(floor)} a month require performance improvement.`;

/** Pay bands: where the person is on the ladder, what the band pays, what the next one needs — and the performance warning. */
function PayBandCard({ s, config, you, open }: { s: Statement; config: Config; you?: boolean; open?: boolean }) {
  const sc = s.scheme;
  const st = sc.step;
  if (!st) return null;
  const who = you ? 'You' : s.staffName;
  return (
    <div>
      <div className="card-kicker">Pay band {st.index} — {fmtKsh(st.payout)}</div>
      {sc.belowFloor && (
        <p className="note" style={{ margin: '0 0 var(--space-2)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-error)', color: 'var(--color-error)' }}>
          <b>{FLOOR_WARNING(sc.floor)}</b> {who} {you ? 'have' : 'has'} sold {fmtKsh(sc.sales)} {open ? 'so far this month' : 'this month'}
          {open ? <> — {fmtKsh(Math.max(0, sc.floor - sc.sales))} more reaches {fmtKsh(sc.floor)}.</> : '.'}
        </p>
      )}
      <p className="note" style={{ marginTop: 0 }}>
        {who} {you ? 'have' : 'has'} brought in <b>{fmtKsh(sc.sales)}</b> in net sales (VAT out) received this month, which pays <b>{fmtKsh(st.payout)}</b>. The payout stays the same until the next band is reached, then it moves up to the new band's payout.
        {st.toNext != null && st.nextPayout != null && (
          <>
            {' '}
            {fmtKsh(st.toNext)} more takes {you ? 'you' : 'them'} to band {st.index + 1} at <b>{fmtKsh(st.nextPayout)}</b>.
          </>
        )}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ maxWidth: 520 }}>
          <thead>
            <tr>
              <th>Band</th>
              <th>Monthly sales</th>
              <th style={numStyle}>Payout</th>
            </tr>
          </thead>
          <tbody>
            {config.payBands.map((b, i) => (
              <tr key={b.from} style={i === st.index ? { fontWeight: 700, background: 'var(--color-surface-2, transparent)' } : undefined}>
                <td>{i === st.index ? `▸ ${i}` : i}</td>
                <td>{i === 0 ? `Below ${fmtKsh(config.payBands[1]?.from ?? 0)}` : config.payBands[i + 1] ? `${fmtKsh(b.from)} – ${fmtKsh(config.payBands[i + 1]!.from - 1)}` : `${fmtKsh(b.from)} and above`}{b.from === config.performanceFloor ? ' (the floor)' : ''}</td>
                <td style={numStyle}>{fmtKsh(b.payout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Where the person stands against the sales target (3 × gross salary), with a bar. */
function TargetCard({ s, you }: { s: Statement; you?: boolean }) {
  const t = s.target;
  if (!t.applies) return null;
  const who = you ? 'You' : s.staffName;
  const done = t.required > 0 ? Math.min(100, Math.round((t.achieved / t.required) * 100)) : 0;
  return (
    <div>
      <div className="card-kicker">Sales target — {!t.salaryKnown ? 'salary needed' : t.met ? 'met' : `${done}% there`}</div>
      {!t.salaryKnown ? (
        <p className="note" style={{ marginTop: 0, color: 'var(--color-error)' }}>
          {you ? 'Your' : 'Their'} gross salary has not been recorded, so there is no target to measure and commission is <b>on hold</b>. Finance adds it under Compliance → Employees.
          {s.heldCommission > 0 && <> {fmtKsh(s.heldCommission)} is waiting.</>}
        </p>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Commission starts once {you ? 'you have' : 'they have'} sold {t.multiplier}× {you ? 'your' : 'their'} gross salary of {fmtKsh(t.salary!)} — <b>{fmtKsh(t.required)}</b> in net sales (VAT out) received in the month. {who} {you ? 'have' : 'has'} sold <b>{fmtKsh(t.achieved)}</b>
            {t.met ? (
              <>
                {' '}
                — <b>target met</b>. {t.mode === 'above' ? <>Commission is paid on the {fmtKsh(t.eligibleSales)} sold above the target.</> : <>Commission is paid on all {fmtKsh(t.achieved)} sold.</>}
              </>
            ) : (
              <>
                {' '}
                — <b>{fmtKsh(t.remaining)} to go</b>.{s.heldCommission > 0 && <> {fmtKsh(s.heldCommission)} earned on film would have been paid had the target been met.</>} A month that misses its target earns no commission on its sales, and nothing rolls over to the next month. Artwork extras are the exception: they are paid whether or not the target is met.
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
function StatementDetail({ s, config, you, open }: { s: Statement; config: Config; you?: boolean; open?: boolean }) {
  const p = s.productivity;
  const who = you ? 'you' : s.staffName;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {s.scheme.mode === 'steps' ? <PayBandCard s={s} config={config} you={you} open={open} /> : <TargetCard s={s} you={you} />}
      <div>
        <div className="card-kicker">Sales {you ? 'you' : 'they'} sourced — {fmtKsh(s.general.commission)}</div>
        <p className="note" style={{ marginTop: 0 }}>
          Money received this month on orders credited to {who}: {fmtKsh(s.general.received)} (VAT included) = <b>{fmtKsh(s.general.netSales)}</b> net. {s.scheme.mode === 'steps' ? <>The month's sales count in full towards the pay bands.</> : <>{you ? 'You are' : s.staffName + ' is'} in the <b>{pct(s.general.band.rate)}</b> band</>}
          {s.scheme.mode !== 'steps' && s.general.band.toNext != null && s.general.band.nextRate != null && (
            <>
              {' '}
              — {fmtKsh(s.general.band.toNext)} more in net sales takes the next slice to {pct(s.general.band.nextRate)}
            </>
          )}
          {s.scheme.mode === 'steps' ? '' : '.'}
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
  if (config.generalMode === 'steps') {
    return (
      <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
        <li>
          <b>Pay bands:</b> your pay for the month is a fixed amount set by the net sales (VAT out) <i>received</i> in the month from clients credited to you —{' '}
          {config.payBands.map((b, i) => `${i === 0 ? 'below ' + fmtKsh(config.payBands[1]?.from ?? 0) : 'from ' + fmtKsh(b.from)} pays ${fmtKsh(b.payout)}`).join(' · ')}. The payout of your band stays the same until you reach the next band, then it moves up to the new band's payout. A client you bring in stays yours for {config.ownershipMonths} months.
        </li>
        <li>
          <b>Performance:</b> {FLOOR_WARNING(config.performanceFloor)} Prices are never relaxed to help reach a band: the minimum prices at order taking stay as they are.
        </li>
        <li>
          <b>Film:</b> everything you charge above the base price per metre earns a share of that extra, with no ceiling —{' '}
          {config.filmBands.map((b, i) => `${i === config.filmBands.length - 1 ? `over ${b.from}` : `${b.from}–${config.filmBands[i + 1]!.from}`} above base: ${pct(b.rate)}`).join(' · ')}.
        </li>
        <li>
          <b>Artwork:</b> you may charge more than the system’s recommended price; you earn {pct(config.artworkRatePct)} of the amount above it, and nothing on the recommended price itself.
        </li>
        <li>Film and artwork commission is earned as the customer pays — a half-paid order earns half — and is paid on top of the band payout.</li>
      </ul>
    );
  }
  return (
    <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
      {config.targetMultiplier > 0 && (
        <li>
          <b>Sales target first:</b> no commission is earned in a month until your net sales received reach <b>{config.targetMultiplier}× your gross monthly salary</b>.{' '}
          {config.targetMode === 'above' ? 'The bands below then start at the target — only what you sell above it earns.' : 'Once it is met, the bands below apply to all of your sales.'} Film extras are paid in full once the target is met. If the target is missed, there is no commission on that month’s sales and nothing rolls over to the next month. The exception is artwork: the extra you charge above the recommended price is paid whether or not the target is met. Prices are never relaxed to help reach it: the minimum prices at order taking stay as they are.
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
  const steps = s.scheme.mode === 'steps';
  const open = period >= thisMonth();
  return (
    <>
      {steps && s.scheme.belowFloor && (
        <p className="note" style={{ margin: 0, padding: 'var(--space-3)', border: '1px solid var(--color-error)', color: 'var(--color-error)' }}>
          <b>{FLOOR_WARNING(s.scheme.floor)}</b> You have sold {fmtKsh(s.scheme.sales)} {open ? 'so far this month' : 'this month'}.
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Stat label="Your commission" value={fmtKsh(s.total)} sub={data.payout ? `${data.payout.status}${data.payout.paidOn ? ' on ' + fmtDate(data.payout.paidOn) : ''}` : 'not yet approved'} />
        <Stat label="Sales you sourced" value={fmtKsh(s.general.commission)} sub={steps ? `${fmtKsh(s.scheme.sales)} net received · pay band ${s.scheme.step?.index ?? 0}` : s.target.held ? `${fmtKsh(s.general.netSales)} net received · below your sales target` : `${fmtKsh(s.general.netSales)} net received · ${pct(s.general.band.rate)} band`} />
        <Stat label="Film" value={fmtKsh(s.film.commission)} />
        <Stat label="Artwork" value={fmtKsh(s.artwork.commission)} />
      </div>
      {!steps && s.target.applies && (
        <Card title="Your sales target" hint="Sell this much in the month and commission starts.">
          <TargetCard s={s} you />
        </Card>
      )}
      <Card title="How you earn" hint="The scheme as it stands today.">
        <SchemeNote config={data.config} />
      </Card>
      <Card title="This month in detail">
        <StatementDetail s={s} config={data.config} you open={open} />
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
                <th style={numStyle} title="Sales made so far this month that count towards the target: money received, net of VAT">Current sales</th>
                <th style={numStyle} title={data.config.generalMode === 'steps' ? `Sales below this in a month require performance improvement` : 'What they must sell in the month before commission starts: the target multiplier × their gross monthly salary'}>{data.config.generalMode === 'steps' ? 'Performance floor' : 'Sales target'}</th>
                <th>Target status</th>
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
                    <td style={numStyle}>{!s.target.applies ? <span className="text-muted">—</span> : !s.target.salaryKnown ? <Tag tone="bad">salary needed</Tag> : fmtKsh(s.target.required)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!s.target.applies || !s.target.salaryKnown ? (
                        <span className="text-muted">—</span>
                      ) : s.target.met ? (
                        <Tag tone="good">target met</Tag>
                      ) : (
                        s.scheme.mode === 'steps' && !data.open ? (
                          <Tag tone="bad">needs improvement</Tag>
                        ) : (
                          <span title={s.heldCommission > 0 ? `${fmtKsh(s.heldCommission)} earned but not paid: the target was not met` : undefined}>{fmtKsh(s.target.remaining)} to go</span>
                        )
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
                      <td colSpan={9} style={{ background: 'var(--color-surface-2, transparent)' }}>
                        <div style={{ padding: 'var(--space-3)' }}>
                          <StatementDetail s={s} config={data.config} open={data.open} />
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
        <p className="note">
          <b>Current sales</b> are the sales made so far this month (money received, net of VAT); {data.config.generalMode === 'steps' ? <>the <b>Performance floor</b> is {fmtKsh(data.config.performanceFloor)} — a closed month below it is marked for performance improvement.</> : <>the <b>Sales target</b> is what they must reach before commission starts.</>} Paying records an expense under Sales Commission, so it reaches the books (and the petty-cash float when paid from petty cash).
        </p>
      </Card>
    </>
  );
}

// ── Month by month ──────────────────────────────────────────────────────────
const monthName = (period: string) => new Date(`${period}-01T00:00:00`).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' });

function MonthlyTab() {
  const thisYear = Number(thisMonth().slice(0, 4));
  const [year, setYear] = useState(String(thisYear));
  const { data, error, loading } = useLoad<MonthlyData>(`/commission/monthly?year=${year}`);
  const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map(String);

  return (
    <>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Year</label>
          <select className="input" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          Print / PDF
        </button>
        <span className="note" style={{ margin: 0 }}>
          Sales are money received in the month on what counts towards the target, net of VAT. Commission is what was earned; a month that has been approved shows the amount approved. A month not yet approved, and the current month, show what has been earned so far.
        </span>
      </div>
      {!data ? (
        <Loading loading={loading} error={error} />
      ) : data.months.length === 0 ? (
        <p className="note">Nothing to show for {year}.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Stat label={`Sales ${year}`} value={fmtKsh(data.totals.sales)} />
            <Stat label="Commission earned" value={fmtKsh(data.totals.commission)} />
            <Stat label="Commission paid" value={fmtKsh(data.totals.paid)} />
            <Stat label="Still to pay" value={fmtKsh(data.totals.outstanding)} />
          </div>

          <Card title={`Each person over ${year}`} hint="Months added up. 'Target met' counts the months they reached their sales target, of the months a target applied.">
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th style={numStyle}>Sales</th>
                    <th style={numStyle}>Commission earned</th>
                    <th style={numStyle}>Paid</th>
                    <th style={numStyle}>Still to pay</th>
                    <th>Target met</th>
                  </tr>
                </thead>
                <tbody>
                  {data.staff.map((p) => (
                    <tr key={p.staffId}>
                      <td>{p.staffName}</td>
                      <td style={numStyle}>{fmtKsh(p.sales)}</td>
                      <td style={numStyle}>{fmtKsh(p.commission)}</td>
                      <td style={numStyle}>{fmtKsh(p.paid)}</td>
                      <td style={numStyle}>{fmtKsh(p.outstanding)}</td>
                      <td>{p.monthsWithTarget > 0 ? `${p.monthsTargetMet} of ${p.monthsWithTarget} months` : <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><b>Total</b></td>
                    <td style={numStyle}><b>{fmtKsh(data.totals.sales)}</b></td>
                    <td style={numStyle}><b>{fmtKsh(data.totals.commission)}</b></td>
                    <td style={numStyle}><b>{fmtKsh(data.totals.paid)}</b></td>
                    <td style={numStyle}><b>{fmtKsh(data.totals.outstanding)}</b></td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {[...data.months].reverse().map((m) => (
            <Card key={m.period} title={monthName(m.period)} hint={m.open ? 'This month is not over: figures are what has been earned so far.' : undefined}>
              {m.rows.length === 0 ? (
                <p className="note" style={{ margin: 0 }}>No sales credited to staff this month.</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Staff</th>
                        <th style={numStyle}>Sales</th>
                        <th style={numStyle}>Sales target</th>
                        <th style={numStyle}>Commission</th>
                        <th style={numStyle}>Paid</th>
                        <th style={numStyle}>Still to pay</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.rows.map((r) => (
                        <tr key={r.staffId}>
                          <td>{r.staffName}</td>
                          <td style={numStyle}>{fmtKsh(r.sales)}</td>
                          <td style={numStyle}>
                            {!r.target.applies ? (
                              <span className="text-muted">—</span>
                            ) : !r.target.salaryKnown ? (
                              <Tag tone="bad">salary needed</Tag>
                            ) : (
                              <>
                                {fmtKsh(r.target.required)} {r.target.met ? <Tag tone="good">met</Tag> : r.belowFloor && !m.open ? <Tag tone="bad">needs improvement</Tag> : <Tag>not met</Tag>}
                              </>
                            )}
                          </td>
                          <td style={numStyle}>
                            {fmtKsh(r.commission)}
                            {r.provisional && r.commission > 0 ? <span className="text-muted" title="Not approved yet: what has been earned so far"> *</span> : null}
                          </td>
                          <td style={numStyle}>{fmtKsh(r.paid)}</td>
                          <td style={numStyle}>{fmtKsh(r.outstanding)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {r.status === 'Paid' ? <Tag tone="good">paid{r.paidOn ? ` ${fmtDate(r.paidOn)}` : ''}</Tag> : r.status === 'Approved' ? <Tag tone="bad">approved, to pay</Tag> : r.status === 'Not approved' ? <Tag>not approved</Tag> : <span className="text-muted">—</span>}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td><b>Month total</b></td>
                        <td style={numStyle}><b>{fmtKsh(m.totals.sales)}</b></td>
                        <td />
                        <td style={numStyle}><b>{fmtKsh(m.totals.commission)}</b></td>
                        <td style={numStyle}><b>{fmtKsh(m.totals.paid)}</b></td>
                        <td style={numStyle}><b>{fmtKsh(m.totals.outstanding)}</b></td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
          <p className="note">* Not approved yet: what has been earned so far. Approve the month under Team &amp; payouts. Freelance sales persons are paid weekly from their own accounts (Freelancers), so they are not in this report.</p>
        </>
      )}
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

function PayBandEditor({ bands, onChange }: { bands: { from: string; payout: string }[]; onChange: (b: { from: string; payout: string }[]) => void }) {
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ maxWidth: 480 }}>
          <thead>
            <tr>
              <th>Band</th>
              <th>From (Ksh net sales a month)</th>
              <th>Payout (Ksh)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={i}>
                <td>{i}</td>
                <td>
                  <input className="input" inputMode="decimal" value={b.from} disabled={i === 0} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                </td>
                <td>
                  <input className="input" inputMode="decimal" value={b.payout} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, payout: e.target.value } : x)))} />
                </td>
                <td>{i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(bands.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...bands, { from: '', payout: '' }])}>
        + Add band
      </button>
    </div>
  );
}

function RatesTab() {
  const { data, error, loading, reload } = useLoad<Config>('/commission/settings');
  const [genMode, setGenMode] = useState<'steps' | 'percent'>('steps');
  const [payBands, setPayBands] = useState<{ from: string; payout: string }[]>([]);
  const [floor, setFloor] = useState('');
  const [general, setGeneral] = useState<{ from: string; rate: string }[]>([]);
  const [film, setFilm] = useState<{ from: string; rate: string }[]>([]);
  const [freelance, setFreelance] = useState<{ from: string; rate: string }[]>([]);
  const [artwork, setArtwork] = useState('');
  const [months, setMonths] = useState('');
  const [flMonths, setFlMonths] = useState('');
  const [flTax, setFlTax] = useState('');
  const [flPremium, setFlPremium] = useState('');
  const [flLow, setFlLow] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [mode, setMode] = useState<'above' | 'all'>('above');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setGeneral(data.generalBands.map((b) => ({ from: String(b.from), rate: String(b.rate) })));
    setFilm(data.filmBands.map((b) => ({ from: String(b.from), rate: String(b.rate) })));
    setFreelance((data.freelanceBands ?? []).map((b) => ({ from: String(b.from), rate: String(b.rate) })));
    setArtwork(String(data.artworkRatePct));
    setMonths(String(data.ownershipMonths));
    setFlMonths(String(data.freelanceOwnershipMonths ?? 12));
    setFlTax(String(data.freelanceWhtRate ?? 5));
    setFlPremium(String(data.freelancePremiumPct ?? 30));
    setFlLow(String(data.freelanceLowMarginPct ?? 50));
    setMultiplier(String(data.targetMultiplier));
    setMode(data.targetMode);
    setGenMode(data.generalMode ?? 'steps');
    setPayBands((data.payBands ?? []).map((b) => ({ from: String(b.from), payout: String(b.payout) })));
    setFloor(String(data.performanceFloor ?? 120000));
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const toBands = (rows: { from: string; rate: string }[]): Band[] => rows.map((r) => ({ from: Number(r.from), rate: Number(r.rate) }));
  const toSteps = payBands.map((r) => ({ from: Number(r.from), payout: Number(r.payout) }));
  const problem = (genMode === 'steps' ? payStepsProblem(toSteps, 'Pay bands') : bandsProblem(toBands(general), 'Sales bands')) ?? bandsProblem(toBands(film), 'Film bands') ?? bandsProblem(toBands(freelance), 'Freelance bands') ?? (genMode === 'steps' && !(Number(floor) >= 0) ? 'Enter the performance floor' : null);

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.put('/commission/settings', { generalBands: toBands(general), filmBands: toBands(film), freelanceBands: toBands(freelance), artworkRatePct: Number(artwork), ownershipMonths: Number(months), freelanceOwnershipMonths: Number(flMonths), freelanceWhtRate: Number(flTax), freelancePremiumPct: Number(flPremium), freelanceLowMarginPct: Number(flLow), targetMultiplier: Number(multiplier), targetMode: mode, generalMode: genMode, payBands: toSteps, performanceFloor: Number(floor) });
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
          <div className="card-kicker">How sales you source are paid</div>
          <div className="field" style={{ margin: 0, maxWidth: 420 }}>
            <select className="input" value={genMode} onChange={(e) => setGenMode(e.target.value as 'steps' | 'percent')}>
              <option value="steps">A fixed payout by the month's sales band (pay bands)</option>
              <option value="percent">A percentage of the sales, in slices, after a salary-multiple target</option>
            </select>
          </div>
        </div>
        {genMode === 'steps' && (
          <div>
            <div className="card-kicker">Pay bands</div>
            <p className="note" style={{ marginTop: 0 }}>
              A person is paid the fixed payout of the highest band their month's net sales (VAT out, money received, on everything credited to them) have reached. It is a step, not a slice: the payout stays the same until the next band is reached, then it moves up to that band's payout. Film and artwork extras are paid on top. Changes apply straight away to any month not yet approved.
            </p>
            <PayBandEditor bands={payBands} onChange={setPayBands} />
            <div className="field" style={{ marginTop: 'var(--space-3)', maxWidth: 320 }}>
              <label>Performance floor — monthly sales below this need improvement (Ksh)</label>
              <input className="input" inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} />
              <p className="note" style={{ margin: 0 }}>Staff are warned on their own screen, and the month is flagged in Team &amp; payouts and the monthly report.</p>
            </div>
          </div>
        )}
        {genMode === 'percent' && (
        <div>
          <div className="card-kicker">Sales target before commission</div>
          <p className="note" style={{ marginTop: 0 }}>
            A person must sell this many times their gross monthly salary (basic plus fixed allowances, before deductions) — net of VAT, money received in the month — before they earn any commission. Their salary is kept on their staff record (Compliance → Employees); with no salary recorded, commission is held. For example 3 × a salary of 40,000 = a target of 120,000. Set 0 for no target. A month that misses its target earns no commission on its sales and nothing rolls over to the next month; the one exception is artwork, whose extra above the recommended price is always paid. Prices at order taking are not affected, so the minimum price rules still stop sales being under-priced to reach a target.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Target = this many × gross salary</label>
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
        )}
        {genMode === 'percent' && (
        <BandEditor
          title="Sales you source"
          hint="Marginal bands on a staff member’s monthly NET sales received from clients credited to them: each rate applies only to the slice of the month that falls inside its band."
          unit="Ksh net per month"
          bands={general}
          onChange={setGeneral}
        />
        )}
        <BandEditor
          title="Film sold above the base price"
          hint="Ksh per metre charged above the base price (the DTF minimum price) → the share of that slice that is paid. The last band has no upper limit: there is no ceiling price."
          unit="Ksh/m above base"
          bands={film}
          onChange={setFilm}
        />
        <BandEditor
          title="Freelance sales persons — weekly, on the base price"
          hint="Marginal bands on the BASE-PRICE part of a freelance sales person's WEEKLY net sales received (Monday to Sunday) on orders credited to them, counting only lines sold at or above our base prices. What was charged above base is paid separately, as a share (below). Keep these rates well inside the margin you make at base price. Each rate applies only to the slice of the week inside its band. Staff do not earn this, and a freelancer's order earns no staff commission."
          unit="Ksh net per week"
          bands={freelance}
          onChange={setFreelance}
        />
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Freelancers: % of the amount charged above base that they keep</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={flPremium} onChange={(e) => setFlPremium(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>The cost of the job does not change when it is sold for more, so this is nearly all profit. The company keeps the rest.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Contracted-out and stock lines count at this % towards the bands</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={flLow} onChange={(e) => setFlLow(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>These carry a thin mark-up. 50 = their base part counts half; 100 = no reduction. Any amount above base is still shared in full.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Artwork: % of the amount above the recommended price</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={artwork} onChange={(e) => setArtwork(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>A sourced client stays credited for (months)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>Applies to clients sourced from now on.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>A freelancer keeps a client while an order comes at least every (months)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={flMonths} onChange={(e) => setFlMonths(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>Every order they bring restarts the count.</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Withholding tax deducted from freelancers' pay (%)</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={flTax} onChange={(e) => setFlTax(e.target.value)} />
            <p className="note" style={{ margin: 0 }}>5% is a placeholder — confirm the rate with your accountant. 0 = none. A person can have their own rate.</p>
          </div>
        </div>
        {problem && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{problem}</p>}
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!problem || !(Number(artwork) >= 0 && Number(artwork) <= 100) || !(Number(months) >= 1) || !(Number(multiplier) >= 0 && Number(multiplier) <= 20) || !(Number(flMonths) >= 1) || !(Number(flTax) >= 0 && Number(flTax) <= 100) || !(Number(flPremium) >= 0 && Number(flPremium) <= 100) || !(Number(flLow) >= 0 && Number(flLow) <= 100)} onClick={save}>
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
  if (manager) tabs.push(['team', 'Team & payouts'], ['monthly', 'Monthly report'], ['clients', 'Clients'], ['freelance', 'Freelancers'], ['rates', 'Rates']);

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
      {tab === 'monthly' && manager && <MonthlyTab />}
      {tab === 'clients' && manager && <ClientsTab />}
      {tab === 'freelance' && manager && <FreelancePanel />}
      {tab === 'rates' && manager && <RatesTab />}
    </>
  );
}
