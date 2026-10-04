import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh, fmtNum, summariseRoll } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, Field } from './shared';
import type { DtfTabProps } from './shared';

// Price approvals: an artwork job charged BELOW the recommended price waits here. It cannot be paid for or produced until a manager
// approves the price; whoever captured it cannot decide it. Rejecting removes the order and the job (the film goes back on the roll).
// For each request the roll's profit is shown as it stands and as it would be if the discount were approved.

interface Approval {
  id: number;
  orderId: number | null;
  orderNo: string;
  rollId: string;
  client: string;
  pieces: number;
  runningMetres: number;
  systemPerPiece: number;
  chargedPerPiece: number;
  shortfall: number;
  pctBelow: number;
  valueAtRecommended: number;
  valueAtCharged: number;
  requestedById: number;
  requestedByName: string;
  requestedAt: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  decidedByName: string | null;
  decidedAt: string | null;
  reason: string | null;
}

export default function DtfApprovals({ data, reload, setError }: DtfTabProps) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');

  function load() {
    setLoading(true);
    api
      .get<Approval[]>('/dtf/approvals')
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load approvals'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function decide(a: Approval, approve: boolean) {
    setBusy(true);
    setError(null);
    setMsg('');
    try {
      await api.post(`/dtf/approvals/${a.id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { reason });
      setMsg(approve ? `${a.orderNo} approved — it can now be paid for and produced` : `${a.orderNo} rejected and removed`);
      setRejecting(null);
      setReason('');
      load();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const pending = rows.filter((r) => r.status === 'Pending');
  const decided = rows.filter((r) => r.status !== 'Pending');

  // The roll as it stands, and as it would stand if this job were approved (its metres are already on the roll while it waits).
  const rollImpact = (a: Approval) => {
    const roll = data.rolls.find((r) => r.id === a.rollId);
    if (!roll) return null;
    const now = summariseRoll(data.settings, roll, data.sales, data.jobs);
    const after = summariseRoll(
      data.settings,
      roll,
      data.sales,
      data.jobs.map((j) => (j.orderId != null && j.orderId === a.orderId ? { ...j, approvalStatus: 'Approved' as const } : j)),
    );
    return { now, after };
  };

  return (
    <>
      {msg && <p className="note" style={{ fontWeight: 700 }}>{msg}</p>}
      <Card title={`Waiting for approval (${pending.length})`}>
        {loading ? (
          <p className="note">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>Nothing is waiting — every artwork job is priced at or above the recommended price, or has been decided.</p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            {pending.map((a) => {
              const imp = rollImpact(a);
              const own = a.requestedById === user?.id;
              return (
                <div key={a.id} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>
                        {a.orderNo} <span className="tag tag-outline">{a.rollId}</span>
                      </div>
                      <div className="note" style={{ margin: 0 }}>
                        {a.client} · {fmtNum(a.pieces)} pieces on {fmtNum(a.runningMetres, 2)} m · asked by {a.requestedByName}, {fmtDate(a.requestedAt.slice(0, 10))}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="card-kicker">Discount</div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 24, color: '#a33' }}>{fmtKsh(a.shortfall)}</div>
                      <div className="note" style={{ margin: 0 }}>{fmtNum(a.pctBelow, 1)}% below recommended</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', margin: 'var(--space-3) 0' }}>
                    <div>
                      <div className="card-kicker">Recommended / piece</div>
                      <b>{fmtKsh(a.systemPerPiece)}</b>
                    </div>
                    <div>
                      <div className="card-kicker">Charged / piece</div>
                      <b style={{ color: '#a33' }}>{fmtKsh(a.chargedPerPiece)}</b>
                    </div>
                    <div>
                      <div className="card-kicker">Job at recommended</div>
                      <b>{fmtKsh(a.valueAtRecommended)}</b>
                    </div>
                    <div>
                      <div className="card-kicker">Job at this price</div>
                      <b>{fmtKsh(a.valueAtCharged)}</b>
                    </div>
                  </div>
                  {imp && (
                    <p className="note" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
                      <b>Impact on {a.rollId}:</b> profit so far {fmtKsh(imp.now.profit)} → <b>{fmtKsh(imp.after.profit)}</b> if approved. The roll’s discounts would then total {fmtKsh(imp.after.discountGiven)} —{' '}
                      {imp.after.profitLostPct == null ? 'no profit to measure against yet' : `${fmtNum(imp.after.profitLostPct, 1)}% of the profit it would make at full prices`}
                      {imp.now.discountGiven > 0 ? ` (${fmtNum(imp.now.profitLostPct ?? 0, 1)}% today)` : ''}.
                    </p>
                  )}
                  {rejecting === a.id ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }}>
                      <Field label="Reason for rejecting">
                        <input className="input" style={{ minWidth: 280 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required" autoFocus />
                      </Field>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !reason.trim()} onClick={() => decide(a, false)}>
                        Reject and remove
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || own} onClick={() => decide(a, true)}>
                        Approve this price
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || own} onClick={() => { setRejecting(a.id); setReason(''); }}>
                        Reject…
                      </button>
                      {own && <span className="note" style={{ margin: 0 }}>You captured this one — another manager has to decide it.</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Decided">
        {decided.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>No decisions yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Roll</th>
                  <th>Client</th>
                  <th style={{ textAlign: 'right' }}>Recommended</th>
                  <th style={{ textAlign: 'right' }}>Charged</th>
                  <th style={{ textAlign: 'right' }}>Discount</th>
                  <th>Asked by</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id}>
                    <td>{a.orderNo}</td>
                    <td>{a.rollId}</td>
                    <td>{a.client}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(a.systemPerPiece, 2)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(a.chargedPerPiece, 2)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(a.shortfall)}</td>
                    <td>{a.requestedByName}</td>
                    <td>
                      <span className={a.status === 'Approved' ? 'tag tag-accent' : 'tag tag-neutral'}>{a.status}</span> <span className="text-muted">{a.decidedByName}</span>
                      {a.reason && <div className="note" style={{ margin: 0 }}>{a.reason}</div>}
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
