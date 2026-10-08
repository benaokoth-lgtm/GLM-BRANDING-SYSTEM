import { Fragment, useEffect, useState } from 'react';
import { EXPENSE_METHODS, FREELANCE_PAY_METHODS, addWeeks, fmtDate, fmtKsh, todayStr, weekStart } from '@glm/shared';
import { api } from '../api/client';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from '../pages/accounting/shared';

// Commission → Freelancers (managers): the weekly pay of freelance sales persons — people outside the staff who bring us work — and their accounts.
// An order marked for a freelancer is credited to them alone (never to a staff member), and they earn marginal-band commission on the net sales they
// bring, received in the week, at or above our base prices. Weeks run Monday to Sunday.

interface Statement {
  agentId: number;
  agentName: string;
  status: string;
  phone: string;
  mpesaNumber: string;
  /** How they like to be paid — it pre-selects the method below. */
  payMethod: string;
  received: number;
  qualifyingNet: number;
  /** The base-price part the bands apply to, and what was charged above base (the premium); the two parts of the commission. */
  baseNet: number;
  premiumNet: number;
  baseCommission: number;
  premiumCommission: number;
  belowBaseNet: number;
  commission: number;
  /** Withholding tax: the rate for this person, the tax deducted, and what they are paid after it. */
  whtRate: number;
  withholdingTax: number;
  netPay: number;
  kraPin: string;
  band: { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null };
  orders: { orderNo: string; customer: string; orderTotal: number; moneyIn: number; qualifyingPct: number; qualifyingNet: number; premiumNet: number }[];
  payout: {
    id: number;
    status: string;
    amount: number;
    withholdingTax: number;
    netPay: number;
    paidOn: string | null;
    paidMethod: string | null;
    receipt: string | null;
    // the latest attempt to send it to their M-Pesa phone
    mpesa: { id: number; status: string; resultDesc: string; receipt: string | null; phone: string; amount: number } | null;
  } | null;
}
interface WeekData {
  weekStart: string;
  weekEnd: string;
  open: boolean;
  /** Can money be sent straight to their phone from here? (If not, M-Pesa is recorded by hand like any other method.) */
  b2cReady: boolean;
  statements: Statement[];
  /** The share of what was charged above base that is paid on top of the bands. */
  premiumPct: number;
  lowMarginPct: number;
  totals: { commission: number; withholdingTax: number; netPay: number };
}
interface AgentRow {
  id: number;
  /** Register number: FL-001 … */
  code: string;
  name: string;
  phone: string;
  email: string;
  nationalId: string;
  kraPin: string;
  mpesaNumber: string;
  /** Their own withholding tax rate (0 = exempt); null = the standard rate. */
  whtRate: number | null;
  payMethod: string;
  bankName: string;
  bankAccount: string;
  status: string;
  note: string;
  createdByName: string;
  orders: number;
}
interface Account {
  agent: AgentRow;
  summary: { paid: number; approvedToPay: number; notYetApproved: number; owed: number; taxWithheld: number };
  weeks: { weekStart: string; weekEnd: string; amount: number; withheld: number; status: string; paidOn: string | null; paidMethod: string | null }[];
}

const statusTone = (s: string): 'good' | 'bad' | 'neutral' => (s === 'Active' ? 'good' : s === 'Suspended' ? 'bad' : 'neutral');

function useRun(reload: () => void) {
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
  return { msg, err, busy, run };
}

// ── Paying one approved payout: any method — M-Pesa, cash, cheque, bank transfer, card, petty cash ──────────────
const METHOD_LABEL: Record<string, string> = { 'Petty Cash': 'Petty cash', Cash: 'Cash', 'M-Pesa': 'M-Pesa (sent by hand)', Cheque: 'Cheque', 'Bank Transfer': 'Bank transfer', Card: 'Card' };
const REFERENCE_HINT: Record<string, string> = { Cheque: 'Cheque no.', 'Bank Transfer': 'Bank reference', 'M-Pesa': 'M-Pesa code', Card: 'Reference' };

function PayCell({ s, b2cReady, busy, run }: { s: Statement; b2cReady: boolean; busy: boolean; run: (fn: () => Promise<string>) => Promise<void> }) {
  // Their usual way pre-selects the method — but any method can be chosen for any payout.
  const usual = (FREELANCE_PAY_METHODS as readonly string[]).includes(s.payMethod) ? s.payMethod : 'M-Pesa';
  const [method, setMethod] = useState<string>(usual === 'M-Pesa' && b2cReady ? 'phone' : usual);
  const [reference, setReference] = useState('');
  const p = s.payout!;
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <Tag tone="bad">approved · pays {fmtKsh(p.netPay)}</Tag>
      <select className="input" style={{ width: 190 }} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="How to pay">
        {b2cReady && <option value="phone">M-Pesa — send to their phone now</option>}
        {EXPENSE_METHODS.map((m) => (
          <option key={m} value={m}>
            {METHOD_LABEL[m] ?? m}
          </option>
        ))}
      </select>
      {method !== 'phone' && REFERENCE_HINT[method] && <input className="input" style={{ width: 120 }} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={REFERENCE_HINT[method]} aria-label="Payment reference" />}
      {method === 'phone' ? (
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/freelance/payouts/${p.id}/send-mpesa`, {}); return `Sent to Safaricom for ${s.agentName} (${s.mpesaNumber}) — it is marked paid when M-Pesa confirms.`; })}>
          Send to M-Pesa
        </button>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/freelance/payouts/${p.id}/pay`, { method, ...(reference.trim() ? { reference: reference.trim() } : {}) }); return `${s.agentName} paid ${fmtKsh(p.amount)} by ${METHOD_LABEL[method] ?? method}${reference.trim() ? ' (' + reference.trim() + ')' : ''}`; })}>
          Mark paid
        </button>
      )}
      {p.mpesa?.status === 'Failed' && <span className="note" style={{ color: 'var(--color-error)', margin: 0, flexBasis: '100%' }}>Last M-Pesa attempt failed: {p.mpesa.resultDesc}</span>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.del(`/freelance/payouts/${p.id}`); return 'Approval withdrawn'; })}>
        Withdraw
      </button>
    </span>
  );
}

// ── The week ────────────────────────────────────────────────────────────────
function WeekTab() {
  const [week, setWeek] = useState(weekStart(todayStr()));
  const { data, error, loading, reload } = useLoad<WeekData>(`/freelance/statement?week=${week}`);
  const [open, setOpen] = useState<number | null>(null);
  const { msg, err, busy, run } = useRun(reload);
  const thisWeek = weekStart(todayStr());

  const approvable = !!data && data.statements.some((s) => s.commission > 0 && s.payout?.status !== 'Paid' && s.payout?.status !== 'Sending');
  // while M-Pesa has a payment on its way, look again every few seconds
  const sending = !!data && data.statements.some((s) => s.payout?.status === 'Sending');
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [sending, reload]);
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setWeek(addWeeks(week, -1))}>
          ← Earlier week
        </button>
        <strong>
          {fmtDate(week)} – {data ? fmtDate(data.weekEnd) : ''}
        </strong>
        <button type="button" className="btn btn-secondary btn-sm" disabled={week >= thisWeek} onClick={() => setWeek(addWeeks(week, 1))}>
          Later week →
        </button>
        {week !== thisWeek && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWeek(thisWeek)}>
            This week
          </button>
        )}
      </div>
      <Notice error={err || error} message={msg} />
      {!data ? (
        <Loading loading={loading} error={error} />
      ) : (
        <>
          {data.open && <p className="note">This week is not over, so more money may still arrive. Approve it once the week has closed (Sunday).</p>}
          <Card
            title="Weekly pay"
            hint={`${fmtKsh(data.totals.commission)} commission, ${fmtKsh(data.totals.withholdingTax)} withholding tax deducted, ${fmtKsh(data.totals.netPay)} to pay. Earned on net sales (VAT out) received this week: a banded rate on the base-price part, plus ${data.premiumPct}% of what was charged above base. Lines sold below base earn nothing.`}
            actions={
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || !approvable} onClick={() => run(async () => {
                const r = await api.post<{ payouts: unknown[]; skipped: { agentName: string; reason: string }[] }>('/freelance/payouts/approve', { weekStart: week });
                return `Week approved.${r.skipped.length ? ' Not approved: ' + r.skipped.map((s) => `${s.agentName} (${s.reason})`).join('; ') : ''}`;
              })}>
                Approve week
              </button>
            }
          >
            {data.statements.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>No money was received on freelance orders this week.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Freelance sales person</th>
                      <th style={numStyle}>Received</th>
                      <th style={numStyle}>Base-price sales (net)</th>
                      <th style={numStyle}>Charged above base (net)</th>
                      <th style={numStyle}>Below base (net, not paid)</th>
                      <th style={numStyle}>Commission</th>
                      <th style={numStyle}>Tax withheld</th>
                      <th style={numStyle}>To pay</th>
                      <th>Usually paid by</th>
                      <th>Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.statements.map((s) => (
                      <Fragment key={s.agentId}>
                        <tr>
                          <td>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === s.agentId ? null : s.agentId)}>
                              {open === s.agentId ? '▾' : '▸'} {s.agentName}
                            </button>{' '}
                            <Tag tone={statusTone(s.status)}>{s.status}</Tag>
                          </td>
                          <td style={numStyle}>{fmtKsh(s.received)}</td>
                          <td style={numStyle}>{fmtKsh(s.baseNet)}</td>
                          <td style={numStyle}>{s.premiumNet > 0 ? fmtKsh(s.premiumNet) : '—'}</td>
                          <td style={numStyle}>{s.belowBaseNet > 0 ? fmtKsh(s.belowBaseNet) : '—'}</td>
                          <td style={numStyle}>
                            {fmtKsh(s.commission)}
                            {s.premiumCommission > 0 && <div className="text-muted" style={{ fontSize: 11 }}>{fmtKsh(s.baseCommission)} bands + {fmtKsh(s.premiumCommission)} above base</div>}
                          </td>
                          <td style={numStyle}>
                            {s.withholdingTax > 0 ? fmtKsh(s.withholdingTax) : '—'}
                            {s.withholdingTax > 0 && <div className="text-muted" style={{ fontSize: 11 }}>{s.whtRate}%{!s.kraPin ? ' · no KRA PIN' : ''}</div>}
                          </td>
                          <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(s.netPay)}</td>
                          <td className="text-muted">{s.payMethod === 'M-Pesa' ? `M-Pesa ${s.mpesaNumber || s.phone}` : METHOD_LABEL[s.payMethod] ?? s.payMethod}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {!s.payout && s.commission > 0 && <Tag>{s.status === 'Active' ? 'not approved' : 'agent not approved'}</Tag>}
                            {s.payout?.status === 'Approved' && <PayCell s={s} b2cReady={data.b2cReady} busy={busy} run={run} />}
                            {s.payout?.status === 'Sending' && (
                              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <Tag tone="bad">on its way to {s.payout.mpesa?.phone ?? 'their phone'}…</Tag>
                                <button type="button" className="btn btn-ghost btn-sm" title="Only if Safaricom's answer never came: check the Paybill's own statement first" disabled={busy} onClick={() => run(async () => {
                                  const code = window.prompt('Safaricom has not answered. Check the Paybill statement. If the money WAS sent, enter its M-Pesa receipt code; if it was NOT sent, leave this empty.');
                                  if (code === null) return 'Left as it was';
                                  if (code.trim()) await api.post(`/freelance/disbursements/${s.payout!.mpesa!.id}/resolve`, { outcome: 'sent', receipt: code.trim() });
                                  else await api.post(`/freelance/disbursements/${s.payout!.mpesa!.id}/resolve`, { outcome: 'failed' });
                                  return code.trim() ? 'Recorded as sent' : 'Recorded as not sent — you can send it again';
                                })}>
                                  Safaricom didn’t answer…
                                </button>
                              </span>
                            )}
                            {s.payout?.status === 'Paid' && <Tag tone="good">paid {s.payout.paidOn ? fmtDate(s.payout.paidOn) : ''} · {s.payout.paidMethod}{s.payout.receipt ? ` ${s.payout.receipt}` : ''}</Tag>}
                          </td>
                        </tr>
                        {open === s.agentId && (
                          <tr>
                            <td colSpan={10}>
                              <div style={{ padding: 'var(--space-3)' }}>
                                <p className="note" style={{ marginTop: 0 }}>
                                  In the <b>{s.band.rate}%</b> band{s.band.toNext != null && s.band.nextRate != null ? <> — {fmtKsh(s.band.toNext)} more takes the next slice to {s.band.nextRate}%</> : null}.
                                </p>
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Order</th>
                                      <th>Customer</th>
                                      <th style={numStyle}>Order total</th>
                                      <th style={numStyle}>Received</th>
                                      <th style={numStyle}>At/above base</th>
                                      <th style={numStyle}>Counts (net)</th>
                                      <th style={numStyle}>Of which above base</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {s.orders.map((o) => (
                                      <tr key={o.orderNo}>
                                        <td>{o.orderNo}</td>
                                        <td>{o.customer}</td>
                                        <td style={numStyle}>{fmtKsh(o.orderTotal)}</td>
                                        <td style={numStyle}>{fmtKsh(o.moneyIn)}</td>
                                        <td style={numStyle}>{o.qualifyingPct}%</td>
                                        <td style={numStyle}>{fmtKsh(o.qualifyingNet)}</td>
                                        <td style={numStyle}>{o.premiumNet > 0 ? fmtKsh(o.premiumNet) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
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
            <p className="note">Pay by whatever suits them — M-Pesa, cash, cheque, bank transfer, card or petty cash — and note the cheque number or reference if there is one. Their usual way is pre-selected, but you can choose any method for any payout. “M-Pesa — send to their phone now” (when set up under Master Data → M-Pesa) asks Safaricom to pay their number from your Paybill and marks it paid when Safaricom confirms; “M-Pesa (sent by hand)” is for when you sent it yourself. Whatever the method, the expense reaches the books under Freelance Commission. Only an approved (Active) freelance sales person is paid.</p>
          </Card>
        </>
      )}
    </>
  );
}

// ── The people ──────────────────────────────────────────────────────────────
const blank = { name: '', phone: '', mpesaNumber: '', nationalId: '', kraPin: '', bankName: '', bankAccount: '', payMethod: 'M-Pesa', whtRate: '' };

interface ClientsData {
  months: number;
  clients: { id: number; clientName: string; agentId: number; agentName: string; startDate: string; lastOrderDate: string; until: string; active: boolean; status: string }[];
}

/** The register of freelance sales persons: add, edit, approve, suspend, and see each one's account. Also shown under Master Data. */
export function PeopleTab() {
  const { data, error, loading, reload } = useLoad<AgentRow[]>('/freelance/agents');
  const [account, setAccount] = useState<number | null>(null);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState(blank);
  const { msg, err, busy, run } = useRun(() => {
    reload();
    clients.reload();
  });
  const acct = useLoad<Account>(account ? `/freelance/agents/${account}/account` : null);
  const clients = useLoad<ClientsData>('/freelance/clients');

  if (!data) return <Loading loading={loading} error={error} />;
  const set = (setter: (f: typeof blank) => void, f: typeof blank, k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setter({ ...f, [k]: e.target.value });
  const payload = (f: typeof blank) => ({ name: f.name, phone: f.phone, mpesaNumber: f.mpesaNumber, nationalId: f.nationalId, kraPin: f.kraPin, bankName: f.bankName, bankAccount: f.bankAccount, payMethod: f.payMethod, whtRate: f.whtRate.trim() === '' ? null : Number(f.whtRate) });
  const pending = data.filter((a) => a.status === 'Pending').length;

  return (
    <>
      <Notice error={err} message={msg} />
      {pending > 0 && <p className="note">{pending} new freelance sales person{pending === 1 ? ' is' : 's are'} waiting for your approval. Orders can be credited to them already, but they are not paid until you approve them.</p>}
      <Card title="Freelance sales persons" hint="The register of people outside the staff who bring us work. Staff pick from this list at order capture, by name, phone or FL number. Their phone number is their account.">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>No.</th>
                <th>Name</th>
                <th>Phone</th>
                <th>Usually paid by</th>
                <th style={numStyle}>Orders</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    None yet. They are added when an order is credited to one, or below.
                  </td>
                </tr>
              )}
              {data.map((a) => (
                <Fragment key={a.id}>
                  <tr>
                    <td className="text-muted">{a.code}</td>
                    <td>
                      <b>{a.name}</b>
                      {a.createdByName && <div className="text-muted" style={{ fontSize: 11 }}>added by {a.createdByName}</div>}
                    </td>
                    <td>{a.phone}</td>
                    <td className="text-muted">
                      {a.payMethod === 'M-Pesa' || !a.payMethod ? `M-Pesa ${a.mpesaNumber || a.phone}` : METHOD_LABEL[a.payMethod] ?? a.payMethod}
                      {a.bankAccount ? ` · ${a.bankName} ${a.bankAccount}` : ''}
                      {a.whtRate != null ? (a.whtRate === 0 ? ' · tax exempt' : ` · tax ${a.whtRate}%`) : ''}
                    </td>
                    <td style={numStyle}>{a.orders}</td>
                    <td>
                      <Tag tone={statusTone(a.status)}>{a.status}</Tag>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAccount(account === a.id ? null : a.id)}>
                        Account
                      </button>{' '}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(editing === a.id ? null : a.id); setDraft({ name: a.name, phone: a.phone, mpesaNumber: a.mpesaNumber, nationalId: a.nationalId, kraPin: a.kraPin, bankName: a.bankName, bankAccount: a.bankAccount, payMethod: a.payMethod || 'M-Pesa', whtRate: a.whtRate == null ? '' : String(a.whtRate) }); }}>
                        Edit
                      </button>{' '}
                      {a.status !== 'Active' && (
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.put(`/freelance/agents/${a.id}`, { status: 'Active' }); return `${a.name} is approved`; })}>
                          {a.status === 'Pending' ? 'Approve' : 'Reactivate'}
                        </button>
                      )}
                      {a.status !== 'Suspended' && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.put(`/freelance/agents/${a.id}`, { status: 'Suspended' }); return `${a.name} is suspended`; })}>
                          Suspend
                        </button>
                      )}
                    </td>
                  </tr>
                  {editing === a.id && (
                    <tr>
                      <td colSpan={7}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-2)', padding: 'var(--space-2) 0' }}>
                          {(['name', 'phone', 'mpesaNumber', 'nationalId', 'kraPin', 'bankName', 'bankAccount'] as const).map((k) => (
                            <div className="field" style={{ margin: 0 }} key={k}>
                              <label>{{ name: 'Name', phone: 'Phone', mpesaNumber: 'M-Pesa number', nationalId: 'National ID', kraPin: 'KRA PIN', bankName: 'Bank', bankAccount: 'Account number' }[k]}</label>
                              <input className="input" value={draft[k]} onChange={set(setDraft, draft, k)} />
                            </div>
                          ))}
                        </div>
                        <div className="field" style={{ margin: '0 0 var(--space-2)', maxWidth: 260 }}>
                          <label>Usually paid by</label>
                          <select className="input" value={draft.payMethod} onChange={(e) => setDraft({ ...draft, payMethod: e.target.value })}>
                            {FREELANCE_PAY_METHODS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field" style={{ margin: '0 0 var(--space-2)', maxWidth: 260 }}>
                          <label>Withholding tax rate % (blank = standard, 0 = exempt)</label>
                          <input className="input" inputMode="decimal" value={draft.whtRate} onChange={(e) => setDraft({ ...draft, whtRate: e.target.value })} />
                        </div>
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(async () => { await api.put(`/freelance/agents/${a.id}`, payload(draft)); setEditing(null); return 'Saved'; })}>
                          Save
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {account && (
        <Card title={acct.data ? `Account — ${acct.data.agent.name}` : 'Account'} hint="What has been earned week by week, what has been paid, and what is still owed.">
          {!acct.data ? (
            <Loading loading={acct.loading} error={acct.error} />
          ) : (
            <>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                {[
                  ['Paid to date', acct.data.summary.paid],
                  ['Approved, waiting to be paid', acct.data.summary.approvedToPay],
                  ['Not yet approved', acct.data.summary.notYetApproved],
                  ['Owed in total', acct.data.summary.owed],
                  ['Tax withheld to date', acct.data.summary.taxWithheld],
                ].map(([label, v]) => (
                  <div key={label as string} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', minWidth: 170 }}>
                    <div className="card-kicker">{label as string}</div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>{fmtKsh(v as number)}</div>
                  </div>
                ))}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th style={numStyle}>Commission</th>
                    <th style={numStyle}>Tax withheld</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {acct.data.weeks.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-muted">
                        Nothing earned yet.
                      </td>
                    </tr>
                  )}
                  {acct.data.weeks.map((w) => (
                    <tr key={w.weekStart}>
                      <td>
                        {fmtDate(w.weekStart)} – {fmtDate(w.weekEnd)}
                      </td>
                      <td style={numStyle}>{fmtKsh(w.amount)}</td>
                      <td style={numStyle}>{w.withheld > 0 ? fmtKsh(w.withheld) : '—'}</td>
                      <td>
                        <Tag tone={w.status === 'Paid' ? 'good' : w.status === 'Approved' ? 'bad' : 'neutral'}>{w.status}</Tag>
                        {w.status === 'Paid' && <span className="text-muted"> {w.paidOn ? fmtDate(w.paidOn) : ''} · {w.paidMethod}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      )}

      <Card title="Clients they own" hint={`A client stays a freelance sales person's for as long as they keep bringing orders — each order restarts the count, and it lapses after ${clients.data?.months ?? 12} months with none. Every order from them is credited to the freelancer, whoever captures it; staff and other freelancers cannot take the client.`}>
        {!clients.data ? (
          <Loading loading={clients.loading} error={clients.error} />
        ) : clients.data.clients.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>None yet. A client becomes theirs the first time an order is credited to them.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Freelance sales person</th>
                  <th>Since</th>
                  <th>Last order</th>
                  <th>Theirs until (if no more orders)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {clients.data.clients.map((c) => (
                  <tr key={c.id}>
                    <td>{c.clientName}</td>
                    <td>{c.agentName}</td>
                    <td className="text-muted">{fmtDate(c.startDate)}</td>
                    <td>{fmtDate(c.lastOrderDate)}</td>
                    <td>{c.active ? fmtDate(c.until) : <Tag>{c.status}</Tag>}</td>
                    <td>
                      {c.active && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/freelance/clients/${c.id}/release`, {}); return `${c.clientName} is released`; })}>
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

      <Card title="Add a freelance sales person" hint="Added here, they are approved straight away. (When staff add one at order capture, you approve it above.)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-2)' }}>
          {(['name', 'phone', 'mpesaNumber', 'nationalId', 'kraPin', 'bankName', 'bankAccount'] as const).map((k) => (
            <div className="field" style={{ margin: 0 }} key={k}>
              <label>{{ name: 'Full name *', phone: 'Phone number *', mpesaNumber: 'M-Pesa number (if different)', nationalId: 'National ID', kraPin: 'KRA PIN', bankName: 'Bank (optional)', bankAccount: 'Account number (optional)' }[k]}</label>
              <input className="input" value={form[k]} onChange={set(setForm, form, k)} />
            </div>
          ))}
        </div>
        <div className="field" style={{ margin: 'var(--space-2) 0 0', maxWidth: 260 }}>
          <label>Withholding tax rate % (blank = standard, 0 = exempt)</label>
          <input className="input" inputMode="decimal" value={form.whtRate} onChange={(e) => setForm({ ...form, whtRate: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 'var(--space-2) 0 0', maxWidth: 260 }}>
          <label>Usually paid by</label>
          <select className="input" value={form.payMethod} onChange={(e) => setForm({ ...form, payMethod: e.target.value })}>
            {FREELANCE_PAY_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !form.name.trim() || !form.phone.trim()}
            onClick={() => run(async () => {
              const body: Record<string, string | number> = { name: form.name, phone: form.phone, payMethod: form.payMethod };
              if (form.whtRate.trim() !== '') body.whtRate = Number(form.whtRate);
              for (const k of ['mpesaNumber', 'nationalId', 'kraPin', 'bankName', 'bankAccount'] as const) if (form[k].trim()) body[k] = form[k];
              const r = await api.post<{ name: string; existing: boolean }>('/freelance/agents', body);
              setForm(blank);
              return r.existing ? `${r.name} already has an account` : `${r.name} is added`;
            })}
          >
            Add
          </button>
        </div>
      </Card>
    </>
  );
}

// ── Tax withheld ────────────────────────────────────────────────────────────
interface TaxData {
  month: string;
  rows: { id: number; paidOn: string | null; agentName: string; kraPin: string; nationalId: string; gross: number; rate: number; withheld: number; net: number; method: string | null; reference: string | null }[];
  totals: { gross: number; withheld: number; net: number };
  missingPin: string[];
}

function TaxTab() {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const { data, error, loading } = useLoad<TaxData>(`/freelance/withholding?month=${month}`);
  return (
    <>
      <div className="field" style={{ margin: 0, maxWidth: 200 }}>
        <label>Month paid</label>
        <input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      {!data ? (
        <Loading loading={loading} error={error} />
      ) : (
        <Card
          title="Withholding tax on freelance commission"
          hint={`${fmtKsh(data.totals.withheld)} withheld from ${fmtKsh(data.totals.gross)} of commission paid in the month — the figures for the withholding return. The tax is held in Withholding Tax Payable until it is paid over to KRA.`}
        >
          {data.missingPin.length > 0 && (
            <p className="note" style={{ color: 'var(--color-error)' }}>
              No KRA PIN on file for {data.missingPin.join(', ')}. KRA needs it for the withholding certificate — add it under Freelance sales persons → Edit.
            </p>
          )}
          {data.rows.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>No commission with tax withheld was paid this month.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Paid</th>
                    <th>Freelance sales person</th>
                    <th>KRA PIN</th>
                    <th style={numStyle}>Commission</th>
                    <th style={numStyle}>Rate</th>
                    <th style={numStyle}>Tax withheld</th>
                    <th style={numStyle}>Paid to them</th>
                    <th>How</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.paidOn ? fmtDate(r.paidOn) : ''}</td>
                      <td>{r.agentName}</td>
                      <td>{r.kraPin || <Tag tone="bad">missing</Tag>}</td>
                      <td style={numStyle}>{fmtKsh(r.gross)}</td>
                      <td style={numStyle}>{r.rate}%</td>
                      <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(r.withheld)}</td>
                      <td style={numStyle}>{fmtKsh(r.net)}</td>
                      <td className="text-muted">
                        {r.method}
                        {r.reference ? ` ${r.reference}` : ''}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}>
                      <b>Total</b>
                    </td>
                    <td style={numStyle}>
                      <b>{fmtKsh(data.totals.gross)}</b>
                    </td>
                    <td></td>
                    <td style={numStyle}>
                      <b>{fmtKsh(data.totals.withheld)}</b>
                    </td>
                    <td style={numStyle}>
                      <b>{fmtKsh(data.totals.net)}</b>
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="note">
            Pay the total over to KRA (iTax) by the date it falls due — check the deadline and the rate with your accountant — then record the payment as a journal in Accounting: debit Withholding Tax Payable, credit the bank. Change the standard rate under Commission → Rates, or give a person their own rate (or 0 if they hold an exemption) under Freelance sales persons → Edit.
          </p>
        </Card>
      )}
    </>
  );
}

export default function FreelancePanel() {
  const [part, setPart] = useState<'week' | 'people' | 'tax'>('week');
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" className={'btn btn-sm ' + (part === 'week' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPart('week')}>
          Weekly pay
        </button>
        <button type="button" className={'btn btn-sm ' + (part === 'people' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPart('people')}>
          Freelance sales persons &amp; accounts
        </button>
        <button type="button" className={'btn btn-sm ' + (part === 'tax' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPart('tax')}>
          Tax withheld
        </button>
      </div>
      {part === 'week' ? <WeekTab /> : part === 'people' ? <PeopleTab /> : <TaxTab />}
    </>
  );
}
