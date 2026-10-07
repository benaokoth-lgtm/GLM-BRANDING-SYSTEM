import { Fragment, useState } from 'react';
import { EXPENSE_METHODS, addWeeks, fmtDate, fmtKsh, todayStr, weekStart } from '@glm/shared';
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
  received: number;
  qualifyingNet: number;
  belowBaseNet: number;
  commission: number;
  band: { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null };
  orders: { orderNo: string; customer: string; orderTotal: number; moneyIn: number; qualifyingPct: number; qualifyingNet: number }[];
  payout: { id: number; status: string; amount: number; paidOn: string | null; paidMethod: string | null } | null;
}
interface WeekData {
  weekStart: string;
  weekEnd: string;
  open: boolean;
  statements: Statement[];
  totals: { commission: number };
}
interface AgentRow {
  id: number;
  name: string;
  phone: string;
  email: string;
  nationalId: string;
  kraPin: string;
  mpesaNumber: string;
  bankName: string;
  bankAccount: string;
  status: string;
  note: string;
  createdByName: string;
  orders: number;
}
interface Account {
  agent: AgentRow;
  summary: { paid: number; approvedToPay: number; notYetApproved: number; owed: number };
  weeks: { weekStart: string; weekEnd: string; amount: number; status: string; paidOn: string | null; paidMethod: string | null }[];
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

// ── The week ────────────────────────────────────────────────────────────────
function WeekTab() {
  const [week, setWeek] = useState(weekStart(todayStr()));
  const { data, error, loading, reload } = useLoad<WeekData>(`/freelance/statement?week=${week}`);
  const [open, setOpen] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof EXPENSE_METHODS)[number]>('M-Pesa');
  const { msg, err, busy, run } = useRun(reload);
  const thisWeek = weekStart(todayStr());

  const approvable = !!data && data.statements.some((s) => s.commission > 0 && s.payout?.status !== 'Paid');
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
            hint={`${fmtKsh(data.totals.commission)} in total. Paid on net sales (VAT out) received this week, at or above our base prices.`}
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
                      <th style={numStyle}>Sales at/above base (net)</th>
                      <th style={numStyle}>Below base (net, not paid)</th>
                      <th style={numStyle}>Commission</th>
                      <th>Pay to</th>
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
                          <td style={numStyle}>{fmtKsh(s.qualifyingNet)}</td>
                          <td style={numStyle}>{s.belowBaseNet > 0 ? fmtKsh(s.belowBaseNet) : '—'}</td>
                          <td style={{ ...numStyle, fontWeight: 700 }}>{fmtKsh(s.commission)}</td>
                          <td className="text-muted">{s.mpesaNumber ? `M-Pesa ${s.mpesaNumber}` : s.phone}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {!s.payout && s.commission > 0 && <Tag>{s.status === 'Active' ? 'not approved' : 'agent not approved'}</Tag>}
                            {s.payout?.status === 'Approved' && (
                              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                <Tag tone="bad">approved</Tag>
                                <select className="input" style={{ width: 130 }} value={method} onChange={(e) => setMethod(e.target.value as (typeof EXPENSE_METHODS)[number])}>
                                  {EXPENSE_METHODS.map((m) => (
                                    <option key={m}>{m}</option>
                                  ))}
                                </select>
                                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.post(`/freelance/payouts/${s.payout!.id}/pay`, { method }); return `${s.agentName} paid ${fmtKsh(s.payout!.amount)} by ${method}`; })}>
                                  Mark paid
                                </button>
                                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.del(`/freelance/payouts/${s.payout!.id}`); return 'Approval withdrawn'; })}>
                                  Withdraw
                                </button>
                              </span>
                            )}
                            {s.payout?.status === 'Paid' && <Tag tone="good">paid {s.payout.paidOn ? fmtDate(s.payout.paidOn) : ''} · {s.payout.paidMethod}</Tag>}
                          </td>
                        </tr>
                        {open === s.agentId && (
                          <tr>
                            <td colSpan={7}>
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
            <p className="note">Paying records an expense under Freelance Commission, so it reaches the books (and the petty-cash float when paid from petty cash). Only an approved (Active) freelance sales person is paid.</p>
          </Card>
        </>
      )}
    </>
  );
}

// ── The people ──────────────────────────────────────────────────────────────
const blank = { name: '', phone: '', mpesaNumber: '', nationalId: '', kraPin: '', bankName: '', bankAccount: '' };

function PeopleTab() {
  const { data, error, loading, reload } = useLoad<AgentRow[]>('/freelance/agents');
  const [account, setAccount] = useState<number | null>(null);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState(blank);
  const { msg, err, busy, run } = useRun(reload);
  const acct = useLoad<Account>(account ? `/freelance/agents/${account}/account` : null);

  if (!data) return <Loading loading={loading} error={error} />;
  const set = (setter: (f: typeof blank) => void, f: typeof blank, k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setter({ ...f, [k]: e.target.value });
  const payload = (f: typeof blank) => ({ name: f.name, phone: f.phone, mpesaNumber: f.mpesaNumber, nationalId: f.nationalId, kraPin: f.kraPin, bankName: f.bankName, bankAccount: f.bankAccount });
  const pending = data.filter((a) => a.status === 'Pending').length;

  return (
    <>
      <Notice error={err} message={msg} />
      {pending > 0 && <p className="note">{pending} new freelance sales person{pending === 1 ? ' is' : 's are'} waiting for your approval. Orders can be credited to them already, but they are not paid until you approve them.</p>}
      <Card title="Freelance sales persons" hint="People outside the staff who bring us work. Their phone number is their account.">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Pays to</th>
                <th style={numStyle}>Orders</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">
                    None yet. They are added when an order is credited to one, or below.
                  </td>
                </tr>
              )}
              {data.map((a) => (
                <Fragment key={a.id}>
                  <tr>
                    <td>
                      <b>{a.name}</b>
                      {a.createdByName && <div className="text-muted" style={{ fontSize: 11 }}>added by {a.createdByName}</div>}
                    </td>
                    <td>{a.phone}</td>
                    <td className="text-muted">
                      M-Pesa {a.mpesaNumber || a.phone}
                      {a.bankAccount ? ` · ${a.bankName} ${a.bankAccount}` : ''}
                    </td>
                    <td style={numStyle}>{a.orders}</td>
                    <td>
                      <Tag tone={statusTone(a.status)}>{a.status}</Tag>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAccount(account === a.id ? null : a.id)}>
                        Account
                      </button>{' '}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(editing === a.id ? null : a.id); setDraft({ name: a.name, phone: a.phone, mpesaNumber: a.mpesaNumber, nationalId: a.nationalId, kraPin: a.kraPin, bankName: a.bankName, bankAccount: a.bankAccount }); }}>
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
                      <td colSpan={6}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-2)', padding: 'var(--space-2) 0' }}>
                          {(['name', 'phone', 'mpesaNumber', 'nationalId', 'kraPin', 'bankName', 'bankAccount'] as const).map((k) => (
                            <div className="field" style={{ margin: 0 }} key={k}>
                              <label>{{ name: 'Name', phone: 'Phone', mpesaNumber: 'M-Pesa number', nationalId: 'National ID', kraPin: 'KRA PIN', bankName: 'Bank', bankAccount: 'Account number' }[k]}</label>
                              <input className="input" value={draft[k]} onChange={set(setDraft, draft, k)} />
                            </div>
                          ))}
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
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {acct.data.weeks.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-muted">
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

      <Card title="Add a freelance sales person" hint="Added here, they are approved straight away. (When staff add one at order capture, you approve it above.)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-2)' }}>
          {(['name', 'phone', 'mpesaNumber', 'nationalId', 'kraPin', 'bankName', 'bankAccount'] as const).map((k) => (
            <div className="field" style={{ margin: 0 }} key={k}>
              <label>{{ name: 'Full name *', phone: 'Phone number *', mpesaNumber: 'M-Pesa number (if different)', nationalId: 'National ID', kraPin: 'KRA PIN', bankName: 'Bank (optional)', bankAccount: 'Account number (optional)' }[k]}</label>
              <input className="input" value={form[k]} onChange={set(setForm, form, k)} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !form.name.trim() || !form.phone.trim()}
            onClick={() => run(async () => {
              const body: Record<string, string> = { name: form.name, phone: form.phone };
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

export default function FreelancePanel() {
  const [part, setPart] = useState<'week' | 'people'>('week');
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" className={'btn btn-sm ' + (part === 'week' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPart('week')}>
          Weekly pay
        </button>
        <button type="button" className={'btn btn-sm ' + (part === 'people' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPart('people')}>
          Freelance sales persons &amp; accounts
        </button>
      </div>
      {part === 'week' ? <WeekTab /> : <PeopleTab />}
    </>
  );
}
