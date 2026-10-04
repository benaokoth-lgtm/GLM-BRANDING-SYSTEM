import { useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import { AsOfBar, Card, DateRangeBar, Loading, Tag, money, numStyle, printPage, useLoad, ymd } from './shared';
import type { Range } from './shared';

// ── Profit & Loss ─────────────────────────────────────────────────────────
interface PlRow {
  id: number;
  code: string;
  name: string;
  amount: number;
  byMonth: number[];
}
interface PlData {
  from: string;
  to: string;
  months: string[];
  income: { rows: PlRow[]; total: number; byMonth: number[] };
  costOfSales: { rows: PlRow[]; total: number; byMonth: number[] };
  grossProfit: number;
  grossByMonth: number[];
  grossMargin: number | null;
  expenses: { rows: PlRow[]; total: number; byMonth: number[] };
  netProfit: number;
  netByMonth: number[];
  margin: number | null;
  outside: { before: { income: number; expenses: number }; after: { income: number; expenses: number } };
  // The four dashboard figures' extras: money received, the comparison with the period before, and a six-month trend.
  dashboard: {
    cashReceived: number;
    revChangePct: number | null;
    profitChangePct: number | null;
    priorFrom: string;
    priorTo: string;
    trend: { label: string; revenue: number; netProfit: number }[];
  };
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card blueprint elev-sm">
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">{label}</div>
      <div className="card-title">{value}</div>
      {sub && (
        <div className="text-muted" style={{ fontSize: 11 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const vsPrior = (pct: number | null) => (pct === null ? 'No prior data' : `${pct >= 0 ? '+' : ''}${pct}% vs prior period`);

export function ProfitLossTab({ range }: { range: Range }) {
  const { data, error, loading } = useLoad<PlData>(`/accounting/profit-loss?from=${range.from}&to=${range.to}`);
  const [byMonth, setByMonth] = useState(false);
  const showMonths = byMonth && !!data && data.months.length > 1 && data.months.length <= 13;

  const section = (title: string, s: PlData['income'], months: string[]) => (
    <>
      <tr>
        <th colSpan={2 + (showMonths ? months.length : 0)} style={{ textAlign: 'left', paddingTop: 'var(--space-3)' }}>
          {title}
        </th>
      </tr>
      {s.rows.length === 0 && (
        <tr>
          <td colSpan={2 + (showMonths ? months.length : 0)} className="text-muted">
            Nothing in this period.
          </td>
        </tr>
      )}
      {s.rows.map((r) => (
        <tr key={r.id}>
          <td>
            <span className="text-muted">{r.code}</span> {r.name}
          </td>
          {showMonths && r.byMonth.map((v, i) => <td key={i} style={numStyle}>{money(v)}</td>)}
          <td style={numStyle}>{money(r.amount)}</td>
        </tr>
      ))}
      <tr style={{ fontWeight: 700 }}>
        <td>Total {title.toLowerCase()}</td>
        {showMonths && s.byMonth.map((v, i) => <td key={i} style={numStyle}>{money(v)}</td>)}
        <td style={numStyle}>{money(s.total)}</td>
      </tr>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <DateRangeBar range={range} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)' }}>
            <Kpi label="Revenue (accrual)" value={fmtKsh(data.income.total)} sub={vsPrior(data.dashboard.revChangePct)} />
            <Kpi label="Revenue (cash received)" value={fmtKsh(data.dashboard.cashReceived)} sub="money received, VAT included" />
            <Kpi label="Gross profit" value={fmtKsh(data.grossProfit)} sub={data.grossMargin != null ? `${data.grossMargin}% gross margin` : undefined} />
            <Kpi label={data.netProfit >= 0 ? 'Net profit' : 'Net loss'} value={fmtKsh(data.netProfit)} sub={`${vsPrior(data.dashboard.profitChangePct)}${data.margin != null ? ` · ${data.margin}% margin` : ''}`} />
          </div>
          <p className="note" style={{ margin: 0 }}>
            Prior comparison period: {fmtDate(data.dashboard.priorFrom)} → {fmtDate(data.dashboard.priorTo)}. Revenue (accrual) is income for the period with VAT taken out; cash received is the money that actually came in.
          </p>
        </>
      )}
      {data && (
        <Card
          title="Profit & Loss"
          hint={`${fmtDate(data.from)} to ${fmtDate(data.to)} — built from every order, expense, wage, credit note and depreciation charge in the books.`}
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {data.months.length > 1 && data.months.length <= 13 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setByMonth((v) => !v)}>
                  {byMonth ? 'Totals only' : 'By month'}
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            </div>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  {showMonths && data.months.map((m) => <th key={m} style={numStyle}>{m}</th>)}
                  <th style={numStyle}>Total (Ksh)</th>
                </tr>
              </thead>
              <tbody>
                {section('Income', data.income, data.months)}
                {section('Cost of sales', data.costOfSales, data.months)}
                <tr style={{ fontFamily: 'var(--font-heading)', fontSize: 17 }}>
                  <td>Gross profit</td>
                  {showMonths && data.grossByMonth.map((v, i) => <td key={i} style={numStyle}>{money(v)}</td>)}
                  <td style={numStyle}>{money(data.grossProfit)}</td>
                </tr>
                {section('Operating expenses', data.expenses, data.months)}
                <tr style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>
                  <td>{data.netProfit >= 0 ? 'Net profit' : 'Net loss'}</td>
                  {showMonths && data.netByMonth.map((v, i) => <td key={i} style={numStyle}>{money(v)}</td>)}
                  <td style={numStyle}>{money(data.netProfit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">
            Cost of sales is what was actually bought — stock purchases and materials expenses — not a percentage of income.
            {data.grossMargin != null && <> Gross margin {data.grossMargin}%{data.margin != null ? `, net margin ${data.margin}%` : ''}.</>}
          </p>
          {(Math.abs(data.outside.before.income) + Math.abs(data.outside.before.expenses) + Math.abs(data.outside.after.income) + Math.abs(data.outside.after.expenses) > 0.005) && (
            <p className="note">
              Outside these dates the books also hold income {money(data.outside.before.income + data.outside.after.income)} and expenses {money(data.outside.before.expenses + data.outside.after.expenses)}.
            </p>
          )}
        </Card>
      )}
      {data && (
        <Card title="Revenue & net profit — last 6 months" hint="The six months ending with the month of the end date.">
          {(() => {
            const max = Math.max(1, ...data.dashboard.trend.map((t) => Math.max(t.revenue, Math.abs(t.netProfit))));
            return (
              <>
                <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', height: 150 }}>
                  {data.dashboard.trend.map((t) => (
                    <div key={t.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
                      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120 }}>
                        <div style={{ width: 14, height: Math.round((Math.max(0, t.revenue) / max) * 120), background: 'var(--color-accent-300)' }} title={fmtKsh(t.revenue)} />
                        <div
                          style={{ width: 14, height: Math.round((Math.abs(t.netProfit) / max) * 120), background: t.netProfit >= 0 ? 'var(--color-accent-600)' : '#b23b2e' }}
                          title={fmtKsh(t.netProfit)}
                        />
                      </div>
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {t.label}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-muted" style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: 11 }}>
                  <span>Revenue</span>
                  <span>Net profit</span>
                </div>
              </>
            );
          })()}
        </Card>
      )}
    </div>
  );
}

// ── Balance sheet ─────────────────────────────────────────────────────────
interface BsRow {
  id: number;
  code: string;
  name: string;
  amount: number;
}
interface BsData {
  asOf: string;
  assets: { rows: BsRow[]; total: number };
  liabilities: { rows: BsRow[]; total: number };
  equity: { rows: BsRow[]; total: number };
  liabilitiesAndEquity: number;
  balanced: boolean;
}

export function BalanceSheetTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading } = useLoad<BsData>(`/accounting/balance-sheet?asOf=${asOf}`);
  const block = (title: string, s: { rows: BsRow[]; total: number }) => (
    <>
      <tr>
        <th colSpan={2} style={{ textAlign: 'left', paddingTop: 'var(--space-3)' }}>
          {title}
        </th>
      </tr>
      {s.rows.length === 0 && (
        <tr>
          <td colSpan={2} className="text-muted">
            None.
          </td>
        </tr>
      )}
      {s.rows.map((r) => (
        <tr key={r.id}>
          <td>
            {r.code && <span className="text-muted">{r.code} </span>}
            {r.name}
          </td>
          <td style={numStyle}>{money(r.amount)}</td>
        </tr>
      ))}
      <tr style={{ fontWeight: 700 }}>
        <td>Total {title.toLowerCase()}</td>
        <td style={numStyle}>{money(s.total)}</td>
      </tr>
    </>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Loading loading={loading} error={error} />
      {data && (
        <Card
          title="Balance Sheet"
          hint={`As at ${fmtDate(data.asOf)}`}
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Tag tone={data.balanced ? 'good' : 'bad'}>{data.balanced ? 'Balanced' : 'Does not balance'}</Tag>
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            </div>
          }
        >
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th style={numStyle}>Ksh</th>
              </tr>
            </thead>
            <tbody>
              {block('Assets', data.assets)}
              {block('Liabilities', data.liabilities)}
              {block('Equity', data.equity)}
              <tr style={{ fontFamily: 'var(--font-heading)', fontSize: 16 }}>
                <td>Liabilities + equity</td>
                <td style={numStyle}>{money(data.liabilitiesAndEquity)}</td>
              </tr>
            </tbody>
          </table>
          <p className="note">
            Accumulated depreciation is shown as a negative asset. Profit not yet closed to retained earnings appears in equity. Stock held is not valued here — purchases are expensed when bought.
          </p>
        </Card>
      )}
    </div>
  );
}

// ── Cash flow ─────────────────────────────────────────────────────────────
interface CfSection {
  total: number;
  lines: { source: string; amount: number }[];
}
interface CfData {
  from: string;
  to: string;
  openingCash: number;
  closingCash: number;
  netChange: number;
  operating: CfSection;
  investing: CfSection;
  financing: CfSection;
  internalTransfers: number;
  reconciles: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  Payment: 'Customer payments received',
  Expense: 'Expenses paid',
  Wages: 'Wages paid (petty cash)',
  'Petty cash top-up': 'Petty cash top-ups',
  'Credit note': 'Customer refunds',
  'M-Pesa receipt': 'M-Pesa receipts (unmatched)',
  'Asset purchase': 'Assets bought',
  Capital: 'Owner capital',
  Drawings: 'Owner drawings',
  Manual: 'Manual journals',
  BankDeposit: 'Bank deposits',
  TaxPayment: 'Tax paid (VAT, PAYE…)',
};

export function CashFlowTab({ range }: { range: Range }) {
  const { data, error, loading } = useLoad<CfData>(`/accounting/cash-flow?from=${range.from}&to=${range.to}`);
  const section = (title: string, s: CfSection) => (
    <>
      <tr>
        <th colSpan={2} style={{ textAlign: 'left', paddingTop: 'var(--space-3)' }}>
          {title}
        </th>
      </tr>
      {s.lines.length === 0 && (
        <tr>
          <td colSpan={2} className="text-muted">
            No cash moved.
          </td>
        </tr>
      )}
      {s.lines.map((l) => (
        <tr key={l.source}>
          <td>{SOURCE_LABEL[l.source] ?? l.source}</td>
          <td style={numStyle}>{money(l.amount)}</td>
        </tr>
      ))}
      <tr style={{ fontWeight: 700 }}>
        <td>Net cash from {title.toLowerCase().replace('activities', 'activities')}</td>
        <td style={numStyle}>{money(s.total)}</td>
      </tr>
    </>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <DateRangeBar range={range} />
      <Loading loading={loading} error={error} />
      {data && (
        <Card
          title="Cash Flow Statement"
          hint={`${fmtDate(data.from)} to ${fmtDate(data.to)} — cash, M-Pesa, card and bank money actually moving (direct method).`}
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Tag tone={data.reconciles ? 'good' : 'bad'}>{data.reconciles ? 'Reconciles to cash accounts' : 'Does not reconcile'}</Tag>
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            </div>
          }
        >
          <table className="table">
            <tbody>
              <tr style={{ fontWeight: 700 }}>
                <td>Opening cash &amp; bank</td>
                <td style={numStyle}>{money(data.openingCash)}</td>
              </tr>
              {section('Operating activities', data.operating)}
              {section('Investing activities', data.investing)}
              {section('Financing activities', data.financing)}
              <tr style={{ fontWeight: 700 }}>
                <td>Net change in cash</td>
                <td style={numStyle}>{money(data.netChange)}</td>
              </tr>
              {Math.abs(data.internalTransfers) > 0.004 && (
                <tr>
                  <td className="text-muted">Transfers between cash accounts (net)</td>
                  <td style={numStyle}>{money(data.internalTransfers)}</td>
                </tr>
              )}
              <tr style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>
                <td>Closing cash &amp; bank</td>
                <td style={numStyle}>{money(data.closingCash)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── Trial balance ─────────────────────────────────────────────────────────
interface TbData {
  asOf: string;
  rows: { id: number; code: string; name: string; type: string; debit: number; credit: number }[];
  debit: number;
  credit: number;
  balanced: boolean;
}

export function TrialBalanceTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading } = useLoad<TbData>(`/accounting/trial-balance?asOf=${asOf}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Loading loading={loading} error={error} />
      {data && (
        <Card
          title="Trial Balance"
          hint="Every account's balance. Total debits must equal total credits."
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Tag tone={data.balanced ? 'good' : 'bad'}>{data.balanced ? 'Debits = credits' : 'Out of balance'}</Tag>
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            </div>
          }
        >
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th style={numStyle}>Debit</th>
                <th style={numStyle}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="text-muted">{r.code}</span> {r.name}
                  </td>
                  <td className="text-muted">{r.type}</td>
                  <td style={numStyle}>{money(r.debit)}</td>
                  <td style={numStyle}>{money(r.credit)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={2}>Totals</td>
                <td style={numStyle}>{money(data.debit)}</td>
                <td style={numStyle}>{money(data.credit)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── General ledger ────────────────────────────────────────────────────────
interface AccountOpt {
  id: number;
  code: string;
  name: string;
}
interface LedgerData {
  account: { id: number; code: string; name: string; type: string };
  opening: number;
  closing: number;
  rows: { date: string; source: string; ref: string; memo: string; debit: number; credit: number; balance: number }[];
}

export function LedgerTab({ range }: { range: Range }) {
  const accounts = useLoad<AccountOpt[]>('/accounting/accounts');
  const [accountId, setAccountId] = useState('');
  const { data, error, loading } = useLoad<LedgerData>(accountId ? `/accounting/ledger?accountId=${accountId}&from=${range.from}&to=${range.to}` : null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <DateRangeBar range={range} />
      <div className="no-print" style={{ maxWidth: 420 }}>
        <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Choose an account…</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      {data && (
        <Card title={`${data.account.code} ${data.account.name}`} hint={`${data.account.type} account — opening ${money(data.opening)}, closing ${money(data.closing)}`} actions={<button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>Print / PDF</button>}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Reference</th>
                <th>Detail</th>
                <th style={numStyle}>Debit</th>
                <th style={numStyle}>Credit</th>
                <th style={numStyle}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    No postings in this period.
                  </td>
                </tr>
              )}
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td className="text-muted">{fmtDate(r.date)}</td>
                  <td>{r.source}</td>
                  <td className="text-muted">{r.ref}</td>
                  <td className="text-muted">{r.memo}</td>
                  <td style={numStyle}>{money(r.debit)}</td>
                  <td style={numStyle}>{money(r.credit)}</td>
                  <td style={numStyle}>{money(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
