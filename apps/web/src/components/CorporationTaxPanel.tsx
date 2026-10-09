import { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';

interface TaxConfig {
  regime: 'corporation' | 'turnover';
  corporationRate: number;
  turnoverRate: number;
  yearEndMonth: number;
}
interface TaxItem {
  key: string;
  label: string;
  dueDate: string;
  amount: number;
  paid: number;
  outstanding: number;
}
interface TurnoverMonth {
  month: string;
  turnover: number;
  tax: number;
  dueDate: string;
  paid: number;
  outstanding: number;
}
interface TaxPayment {
  id: number;
  period: string;
  date: string;
  amount: number;
  reference: string;
  note: string;
  capturedByName: string;
}
interface TaxYear {
  year: number;
  period: { start: string; end: string };
  regime: 'corporation' | 'turnover';
  rate: number;
  profit: number;
  autoAddBacks: { label: string; amount: number }[];
  adjusted: number;
  capitalAllowances: number;
  taxLoss: number;
  lossesUsed: number;
  taxable: number;
  tax: number;
  credits: number;
  taxAfterCredits: number;
  estimate: number;
  suggestedEstimate: number;
  estimateIsManual: boolean;
  priorTax: number;
  items: TaxItem[];
  totalPaid: number;
  overpaid: number;
  outstanding: number;
  turnover: { rate: number; annual: number; eligible: boolean; months: TurnoverMonth[]; tax: number; outstanding: number };
  adjustments: { addBacks: number; capitalAllowances: number; lossesUsed: number; whtCredits: number; estimateTax: number | null; note: string };
  payments: TaxPayment[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const R = { textAlign: 'right' } as const;
const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' });

export default function CorporationTaxPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const thisYear = Number(todayStr().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [cfg, setCfg] = useState<TaxConfig | null>(null);
  const [data, setData] = useState<TaxYear | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ addBacks: '', capitalAllowances: '', lossesUsed: '', whtCredits: '', estimateTax: '', note: '' });
  const [pay, setPay] = useState({ period: 'I1', date: todayStr(), amount: '', reference: '' });

  const apply = useCallback((d: TaxYear) => {
    setData(d);
    const a = d.adjustments;
    setForm({ addBacks: a.addBacks ? String(a.addBacks) : '', capitalAllowances: a.capitalAllowances ? String(a.capitalAllowances) : '', lossesUsed: a.lossesUsed ? String(a.lossesUsed) : '', whtCredits: a.whtCredits ? String(a.whtCredits) : '', estimateTax: a.estimateTax != null ? String(a.estimateTax) : '', note: a.note });
  }, []);

  const load = useCallback(async () => {
    setErr('');
    try {
      const c = await api.get<TaxConfig>('/tax/settings');
      setCfg(c);
      apply(await api.get<TaxYear>(`/tax/year/${year}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the tax');
    }
  }, [year, apply]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  async function run(fn: () => Promise<TaxYear | TaxConfig | void>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not save');
    } finally {
      setBusy(false);
    }
  }

  const saveSettings = (next: TaxConfig) =>
    run(async () => {
      setCfg(await api.put<TaxConfig>('/tax/settings', next));
      apply(await api.get<TaxYear>(`/tax/year/${year}`));
    });
  const saveAdjust = () =>
    run(async () => {
      apply(
        await api.put<TaxYear>(`/tax/year/${year}`, {
          addBacks: num(form.addBacks),
          capitalAllowances: num(form.capitalAllowances),
          lossesUsed: num(form.lossesUsed),
          whtCredits: num(form.whtCredits),
          estimateTax: form.estimateTax.trim() === '' ? null : num(form.estimateTax),
          note: form.note,
        }),
      );
    });
  const recordPayment = () =>
    run(async () => {
      apply(await api.post<TaxYear>(`/tax/year/${year}/payments`, { period: pay.period, date: pay.date, amount: num(pay.amount), reference: pay.reference }));
      setPay((p) => ({ ...p, amount: '', reference: '' }));
    });
  const removePayment = (id: number) => run(async () => apply(await api.del<TaxYear>(`/tax/payments/${id}`)));

  if (!cfg || !data) return err ? <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p> : <p className="note">Loading…</p>;

  const turnoverMode = cfg.regime === 'turnover';
  const periodLabel = (p: string) => (p === 'FINAL' ? 'Balance of the tax' : /^I\d$/.test(p) ? `Instalment ${p.slice(1)}` : monthLabel(p));
  const payOptions: [string, string][] = turnoverMode ? data.turnover.months.map((m) => [m.month, monthLabel(m.month)]) : data.items.map((i) => [i.key, i.label]);
  const field = (label: string, key: keyof typeof form, hint?: string) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <input className="input" type="number" min="0" step="0.01" disabled={!isAdmin} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} placeholder="0" />
      {hint && <p className="note" style={{ margin: 'var(--space-1) 0 0' }}>{hint}</p>}
    </div>
  );
  const corner = (
    <>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
    </>
  );

  return (
    <>
      {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}

      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        {corner}
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Tax year (ending)</label>
            <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear - 3, thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>The business is taxed as</label>
            <select className="input" disabled={!isAdmin || busy} value={cfg.regime} onChange={(e) => saveSettings({ ...cfg, regime: e.target.value as TaxConfig['regime'] })}>
              <option value="corporation">A company — corporation tax</option>
              <option value="turnover">Small business — turnover tax</option>
            </select>
          </div>
          {!turnoverMode && (
            <div className="field" style={{ margin: 0, width: 110 }}>
              <label>Rate %</label>
              <input className="input" type="number" min="0" max="100" step="0.5" disabled={!isAdmin || busy} defaultValue={cfg.corporationRate} key={`c${cfg.corporationRate}`} onBlur={(e) => Number(e.target.value) !== cfg.corporationRate && saveSettings({ ...cfg, corporationRate: Number(e.target.value) })} />
            </div>
          )}
          {turnoverMode && (
            <div className="field" style={{ margin: 0, width: 110 }}>
              <label>Rate %</label>
              <input className="input" type="number" min="0" max="100" step="0.5" disabled={!isAdmin || busy} defaultValue={cfg.turnoverRate} key={`t${cfg.turnoverRate}`} onBlur={(e) => Number(e.target.value) !== cfg.turnoverRate && saveSettings({ ...cfg, turnoverRate: Number(e.target.value) })} />
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>Financial year ends</label>
            <select className="input" disabled={!isAdmin || busy} value={cfg.yearEndMonth} onChange={(e) => saveSettings({ ...cfg, yearEndMonth: Number(e.target.value) })}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  End of {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="note" style={{ margin: 'var(--space-3) 0 0' }}>
          Year {fmtDate(data.period.start)} to {fmtDate(data.period.end)}. {isAdmin ? '' : 'Only an Admin can change these settings, the adjustments or record a payment. '}
          This is worked out from the books and kept apart from them: Accounting still shows the profit before income tax.
        </p>
      </div>

      {!turnoverMode && (
        <>
          <div className="card blueprint" style={{ padding: 'var(--space-4)', display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
            {corner}
            <div>
              <div className="card-kicker">Corporation tax for {year}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, lineHeight: 1.1 }}>{fmtKsh(data.taxAfterCredits)}</div>
              <div className="note" style={{ margin: 0 }}>
                {data.taxLoss > 0 ? `A tax loss of ${fmtKsh(data.taxLoss)} — no tax this year; it is carried forward for 5 years.` : `${data.rate}% of the taxable profit of ${fmtKsh(data.taxable)}${data.credits ? `, less ${fmtKsh(data.credits)} already withheld at source` : ''}.`}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="card-kicker">Still to pay for {year}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 28 }}>{fmtKsh(data.outstanding)}</div>
              <div className="note" style={{ margin: 0 }}>
                Paid so far {fmtKsh(data.totalPaid)}
                {data.overpaid > 0 ? ` — ${fmtKsh(data.overpaid)} more than the tax` : ''}
              </div>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            {corner}
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              From the books to the tax
            </div>
            <table className="table" style={{ maxWidth: 640 }}>
              <tbody>
                <tr>
                  <td>Profit before tax, per the books</td>
                  <td style={R}>{fmtKsh(data.profit)}</td>
                </tr>
                {data.autoAddBacks.map((b) => (
                  <tr key={b.label}>
                    <td className="text-muted">Add: {b.label}</td>
                    <td style={R}>{fmtKsh(b.amount)}</td>
                  </tr>
                ))}
                {data.adjustments.addBacks > 0 && (
                  <tr>
                    <td className="text-muted">Add: other expenses not allowed</td>
                    <td style={R}>{fmtKsh(data.adjustments.addBacks)}</td>
                  </tr>
                )}
                <tr style={{ fontWeight: 700 }}>
                  <td>Adjusted profit</td>
                  <td style={R}>{fmtKsh(data.adjusted)}</td>
                </tr>
                {data.capitalAllowances > 0 && (
                  <tr>
                    <td className="text-muted">Less: capital allowances</td>
                    <td style={R}>({fmtKsh(data.capitalAllowances)})</td>
                  </tr>
                )}
                {data.lossesUsed > 0 && (
                  <tr>
                    <td className="text-muted">Less: tax losses brought forward</td>
                    <td style={R}>({fmtKsh(data.lossesUsed)})</td>
                  </tr>
                )}
                <tr style={{ fontWeight: 700 }}>
                  <td>Taxable profit</td>
                  <td style={R}>{fmtKsh(data.taxable)}</td>
                </tr>
                <tr>
                  <td>Tax at {data.rate}%</td>
                  <td style={R}>{fmtKsh(data.tax)}</td>
                </tr>
                {data.credits > 0 && (
                  <tr>
                    <td className="text-muted">Less: tax withheld at source (certificates held)</td>
                    <td style={R}>({fmtKsh(data.credits)})</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr style={{ fontFamily: 'var(--font-heading)' }}>
                  <td>Tax payable for {year}</td>
                  <td style={R}>{fmtKsh(data.taxAfterCredits)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            {corner}
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Adjustments for {year}
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              The books already add back depreciation and entertainment, fines, penalties and donations. Enter the rest here — figures from your tax computation. Capital allowances replace depreciation (the system does not track the asset classes, so enter the total).
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 'var(--space-3)' }}>
              {field('Other expenses not allowed', 'addBacks', 'Added to the profit')}
              {field('Capital allowances', 'capitalAllowances', 'Taken off the profit')}
              {field('Tax losses brought forward — use', 'lossesUsed', 'Losses of the last 5 years; never below nil')}
              {field('Tax withheld at source', 'whtCredits', 'Credit for withholding-tax certificates held')}
              {field('Estimated tax for the year', 'estimateTax', `Leave blank to use ${fmtKsh(data.suggestedEstimate)} (the lower of this year's estimate and 110% of last year's ${fmtKsh(data.priorTax)})`)}
            </div>
            <div className="field" style={{ marginTop: 'var(--space-3)' }}>
              <label>Note</label>
              <input className="input" disabled={!isAdmin} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} maxLength={500} />
            </div>
            {isAdmin && (
              <button type="button" className="btn btn-primary blueprint" disabled={busy} onClick={saveAdjust}>
                {corner}
                Save adjustments
              </button>
            )}
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            {corner}
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Payments to KRA for {year}
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              Four equal instalments of the estimated tax on the 20th of months 4, 6, 9 and 12 of the year, and the balance by the last day of the 4th month after the year ends (the return is due by the 6th month). Each shows in Payments due, in the month before its date.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Due</th>
                    <th style={R}>Amount</th>
                    <th style={R}>Paid</th>
                    <th style={R}>Owing</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.key}>
                      <td>{i.label}</td>
                      <td className="text-muted">{fmtDate(i.dueDate)}</td>
                      <td style={R}>{fmtKsh(i.amount)}</td>
                      <td style={R}>{i.paid ? fmtKsh(i.paid) : '—'}</td>
                      <td style={{ ...R, fontWeight: i.outstanding > 0 ? 700 : undefined }}>{i.outstanding > 0 ? fmtKsh(i.outstanding) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontFamily: 'var(--font-heading)' }}>
                    <td colSpan={2}>Total</td>
                    <td style={R}>{fmtKsh(data.items.reduce((a, i) => a + i.amount, 0))}</td>
                    <td style={R}>{fmtKsh(data.totalPaid)}</td>
                    <td style={R}>{fmtKsh(data.outstanding)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {turnoverMode && (
        <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
          {corner}
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
            Turnover tax for {year}
          </div>
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            {data.turnover.rate}% of each month's sales (without VAT), paid by the 20th of the next month. Open to a business with sales of KES 1 million to 25 million a year; sales this year are {fmtKsh(data.turnover.annual)}
            {data.turnover.eligible ? '.' : ' — outside that range, so this business may not qualify.'} Rental, professional and management income are not covered.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Pay by</th>
                  <th style={R}>Sales</th>
                  <th style={R}>Tax</th>
                  <th style={R}>Paid</th>
                  <th style={R}>Owing</th>
                </tr>
              </thead>
              <tbody>
                {data.turnover.months.map((m) => (
                  <tr key={m.month}>
                    <td>{monthLabel(m.month)}</td>
                    <td className="text-muted">{fmtDate(m.dueDate)}</td>
                    <td style={R}>{m.turnover ? fmtKsh(m.turnover) : '—'}</td>
                    <td style={R}>{m.tax ? fmtKsh(m.tax) : '—'}</td>
                    <td style={R}>{m.paid ? fmtKsh(m.paid) : '—'}</td>
                    <td style={{ ...R, fontWeight: m.outstanding > 0 ? 700 : undefined }}>{m.outstanding > 0 ? fmtKsh(m.outstanding) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontFamily: 'var(--font-heading)' }}>
                  <td colSpan={2}>Total</td>
                  <td style={R}>{fmtKsh(data.turnover.annual)}</td>
                  <td style={R}>{fmtKsh(data.turnover.tax)}</td>
                  <td style={R}>{fmtKsh(data.totalPaid)}</td>
                  <td style={R}>{fmtKsh(data.turnover.outstanding)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        {corner}
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
          Record a payment to KRA
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>For</label>
              <select className="input" value={payOptions.some(([k]) => k === pay.period) ? pay.period : payOptions[0]?.[0]} onChange={(e) => setPay((p) => ({ ...p, period: e.target.value }))}>
                {payOptions.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Date paid</label>
              <input className="input" type="date" value={pay.date} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Amount</label>
              <input className="input" type="number" min="0" step="0.01" value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>KRA reference</label>
              <input className="input" value={pay.reference} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} maxLength={120} />
            </div>
            <button type="button" className="btn btn-primary blueprint" disabled={busy || !(num(pay.amount) > 0)} onClick={recordPayment}>
              {corner}
              Record payment
            </button>
          </div>
        )}
        {data.payments.length === 0 ? (
          <p className="note">No payments recorded for {year}.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>For</th>
                <th>Reference</th>
                <th>Captured by</th>
                <th style={R}>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td>
                  <td>{periodLabel(p.period)}</td>
                  <td className="text-muted">{p.reference || '—'}</td>
                  <td className="text-muted">{p.capturedByName || '—'}</td>
                  <td style={R}>{fmtKsh(p.amount)}</td>
                  <td>
                    {isAdmin && (
                      <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy} onClick={() => removePayment(p.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Recording a payment here only counts it off this schedule. To take it out of the bank in the books, post it as a journal (Accounting → Journals) or an expense.
        </p>
      </div>
    </>
  );
}
