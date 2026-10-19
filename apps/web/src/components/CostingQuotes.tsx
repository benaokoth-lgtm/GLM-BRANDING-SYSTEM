import { useEffect, useState } from 'react';
import { costingJobLabel, fmtDate, fmtKsh, isNamedClient } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { printOrderDocument } from '../utils/printInvoice';
import CostingQuoteSend from './CostingQuoteSend';
import SourcingField from './SourcingField';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from './SplitPayments';
import type { PaymentRow } from './SplitPayments';
import { Loading, Tag, numStyle } from '../pages/accounting/shared';

// Sales → Job Costing → Saved quotes. A costing kept for a client. When the client agrees a price (perhaps after talking the margin down) it is recorded here; a price at or above the
// floor goes straight through, a lower one waits for Finance, the General Manager or Admin (never the person who quoted it). The accepted quote is then captured as an ordinary order
// at the agreed price. The cost lines are shown to everyone; the margin only to people who may see costs.

export interface QuoteView {
  id: number;
  quoteNo: string;
  status: 'Draft' | 'Sent' | 'Lost' | 'Ordered';
  createdDate: string;
  validUntil: string;
  expired: boolean;
  clientName: string;
  phone: string;
  note: string;
  staffId: number;
  staffName: string;
  jobType: string;
  summary: string;
  lines: { rateId: number; name: string; note: string; amount: number }[];
  cost: number;
  price: number;
  vat: number;
  total: number;
  lowestPrice: number;
  lowestTotal: number;
  agreed: { price: number; vat: number; total: number; needsApproval: boolean; marginPct?: number } | null;
  approval: '' | 'Pending' | 'Approved' | 'Rejected';
  approvalNote: string;
  approvedByName: string;
  lostReason: string;
  orderId: number | null;
  orderNo: string;
  marginPct?: number;
  floorMarginPct?: number;
  profit?: number;
}

const FILTERS: [string, string][] = [
  ['open', 'Open'],
  ['approval', 'Waiting for approval'],
  ['Ordered', 'Ordered'],
  ['Lost', 'Lost'],
  ['all', 'All'],
];
const pct = (n: number) => `${parseFloat(n.toFixed(1))}%`;

function stateOf(q: QuoteView): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  if (q.status === 'Ordered') return { label: `Order ${q.orderNo}`, tone: 'good' };
  if (q.status === 'Lost') return { label: 'Lost', tone: 'bad' };
  if (q.approval === 'Pending') return { label: 'Waiting for approval', tone: 'bad' };
  if (q.approval === 'Rejected') return { label: 'Price not approved', tone: 'bad' };
  if (q.agreed) return { label: 'Price agreed', tone: 'good' };
  return { label: q.expired ? `${q.status} · expired` : q.status, tone: 'neutral' };
}

export default function CostingQuotes({ openId, onOpened }: { openId?: number | null; onOpened?: () => void }) {
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState<{ quotes: QuoteView[]; canSeeCosts: boolean } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    api
      .get<{ quotes: QuoteView[]; canSeeCosts: boolean }>('/costing/quotes')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the quotes'));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (openId) {
      setOpen(openId);
      onOpened?.();
    }
  }, [openId]);

  if (!data) return <Loading loading={!error} error={error} />;
  const shown = data.quotes.filter((q) => (filter === 'all' ? true : filter === 'open' ? q.status === 'Draft' || q.status === 'Sent' : filter === 'approval' ? q.approval === 'Pending' : q.status === filter));
  const waiting = data.quotes.filter((q) => q.approval === 'Pending').length;
  const current = data.quotes.find((q) => q.id === open) ?? null;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="seg no-print" role="radiogroup" aria-label="Show">
        {FILTERS.map(([k, label]) => (
          <label key={k} className={'seg-opt' + (filter === k ? ' checked' : '')}>
            <input type="radio" name="cqfilter" checked={filter === k} onChange={() => setFilter(k)} />
            {label}
            {k === 'approval' && waiting > 0 ? ` (${waiting})` : ''}
          </label>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>
          {data.quotes.length === 0 ? 'No quotes yet — cost a job on the Calculator and press “Save as quote”.' : 'Nothing under this heading.'}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Quote</th>
                <th>Client</th>
                <th>Job</th>
                <th>Salesperson</th>
                <th style={numStyle}>Quoted (VAT incl.)</th>
                <th style={numStyle}>Agreed (VAT incl.)</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((q) => {
                const st = stateOf(q);
                return (
                  <tr key={q.id}>
                    <td>
                      <b>{q.quoteNo}</b>
                      <div className="text-muted" style={{ fontSize: 11 }}>{fmtDate(q.createdDate)}</div>
                    </td>
                    <td>{q.clientName}</td>
                    <td>
                      {costingJobLabel(q.jobType)}
                      <div className="text-muted" style={{ fontSize: 11 }}>{q.summary}</div>
                    </td>
                    <td>{q.staffName}</td>
                    <td style={numStyle}>{fmtKsh(q.total)}</td>
                    <td style={numStyle}>{q.agreed ? fmtKsh(q.agreed.total) : '—'}</td>
                    <td><Tag tone={st.tone}>{st.label}</Tag></td>
                    <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(q.id)}>Open</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {current && <QuoteDialog quote={current} canSeeCosts={data.canSeeCosts} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function QuoteDialog({ quote: q, canSeeCosts, onClose, onChanged }: { quote: QuoteView; canSeeCosts: boolean; onClose: () => void; onChanged: () => Promise<unknown> | void }) {
  const { user } = useAuth();
  const [agreed, setAgreed] = useState(q.agreed ? String(q.agreed.total) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [capturing, setCapturing] = useState(false);
  const closed = q.status === 'Ordered' || q.status === 'Lost';
  const mine = q.staffId === user?.id;
  const typed = Number(agreed);
  const underFloor = typed > 0 && typed < q.lowestTotal - 0.005;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, body: unknown = {}) => run(() => api.post(`/costing/quotes/${q.id}/${path}`, body));
  const canCapture = !closed && !!q.agreed && (q.approval === '' || q.approval === 'Approved');
  const st = stateOf(q);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 640, width: '100%', maxHeight: '92vh', overflowY: 'auto', display: 'grid', gap: 'var(--space-3)' }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          {q.quoteNo} · {q.clientName} <Tag tone={st.tone}>{st.label}</Tag>
        </div>
        <p className="note" style={{ margin: 0 }}>
          {costingJobLabel(q.jobType)} · {q.summary} · quoted by {q.staffName} on {fmtDate(q.createdDate)}, valid to {fmtDate(q.validUntil)}
          {q.phone ? ` · ${q.phone}` : ''}
        </p>

        <div style={{ borderTop: '1px solid var(--color-divider)' }}>
          {q.lines.map((l) => (
            <div key={l.rateId} style={{ display: 'flex', gap: 'var(--space-2)', padding: '6px 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 14 }}>
              <span style={{ flex: 1 }}>
                {l.name}
                <div className="text-muted" style={{ fontSize: 11 }}>{l.note}</div>
              </span>
              <b style={numStyle}>{fmtKsh(l.amount)}</b>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 2px', fontWeight: 700 }}>
            <span>Production cost</span>
            <span style={numStyle}>{fmtKsh(q.cost)}</span>
          </div>
          {canSeeCosts && q.marginPct != null && (
            <div className="text-muted" style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px 6px', fontSize: 13 }}>
              <span>Quoted at a margin of {pct(q.marginPct)} on cost (the lowest without approval is {pct(q.floorMarginPct ?? 0)})</span>
              <span style={numStyle}>profit {fmtKsh(q.profit ?? 0)}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px var(--space-4)' }}>
          <span>Quoted price (before VAT)</span>
          <b style={numStyle}>{fmtKsh(q.price)}</b>
          <span className="text-muted">VAT 16%</span>
          <span style={numStyle}>{fmtKsh(q.vat)}</span>
          <span>Quoted — the client pays (VAT included)</span>
          <b style={numStyle}>{fmtKsh(q.total)}</b>
        </div>

        {!closed && (
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
            <div className="card-kicker">Price agreed with the client</div>
            <div className="field" style={{ margin: 0, maxWidth: 280 }}>
              <label>The client pays, VAT included (Ksh)</label>
              <input className="input" inputMode="decimal" value={agreed} onChange={(e) => setAgreed(e.target.value)} placeholder={String(q.total)} disabled={busy} />
            </div>
            <p className="note" style={{ margin: 0 }}>
              You may agree down to <b>{fmtKsh(q.lowestTotal)}</b> (VAT included) without approval. Lower than that needs Finance, the General Manager or Admin to approve it; the job cannot be sold for less than it costs us.
            </p>
            {underFloor && <p className="note" style={{ margin: 0, color: 'var(--color-error)' }}>This price is under that limit — it will wait for approval before the order can be captured.</p>}
            <div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !(typed > 0)} onClick={() => post('agree', { total: typed })}>
                Record the agreed price
              </button>
            </div>
            {q.agreed && (
              <p className="note" style={{ margin: 0 }}>
                Agreed: <b>{fmtKsh(q.agreed.total)}</b> with VAT ({fmtKsh(q.agreed.price)} before VAT)
                {canSeeCosts && q.agreed.marginPct != null ? ` · a margin of ${pct(q.agreed.marginPct)} on cost` : ''}.{' '}
                {q.approval === 'Pending' && <b>Waiting for approval.</b>}
                {q.approval === 'Approved' && <>Approved by {q.approvedByName}.</>}
                {q.approval === 'Rejected' && <b style={{ color: 'var(--color-error)' }}>Not approved by {q.approvedByName}: “{q.approvalNote}”. Agree another price.</b>}
              </p>
            )}
            {q.approval === 'Pending' && canSeeCosts && !mine && (
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => post('approve')}>Approve this price</button>
                <input className="input" style={{ maxWidth: 260 }} placeholder="Reason, to reject it" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || reason.trim().length < 3} onClick={() => post('reject', { reason })}>Reject</button>
              </div>
            )}
            {q.approval === 'Pending' && canSeeCosts && mine && <p className="note" style={{ margin: 0 }}>You quoted this, so someone else has to approve the price.</p>}
          </div>
        )}
        {q.status === 'Lost' && <p className="note" style={{ margin: 0 }}>Lost: {q.lostReason}</p>}
        {q.status === 'Ordered' && <p className="note" style={{ margin: 0 }}>Captured as order <b>{q.orderNo}</b> — the order is under All Orders.</p>}
        {err && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</p>}

        <CostingQuoteSend quoteId={q.id} defaultPhone={q.phone} onError={(m) => setErr(m ?? '')} />

        <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          {!closed && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  const why = window.prompt('Why was this quote lost?');
                  if (why && why.trim().length >= 3) void post('status', { status: 'Lost', reason: why.trim() });
                }}
              >
                Mark lost
              </button>
              <button type="button" className="btn btn-primary blueprint" disabled={busy || !canCapture} title={canCapture ? '' : 'Record the agreed price first (and have it approved if it is under the limit)'} onClick={() => setCapturing(true)}>
                Capture as order
              </button>
            </>
          )}
        </div>
      </div>
      {capturing && q.agreed && (
        <CaptureDialog
          quote={q}
          total={q.agreed.total}
          onClose={() => setCapturing(false)}
          onDone={async () => {
            setCapturing(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function CaptureDialog({ quote: q, total, onClose, onDone }: { quote: QuoteView; total: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { user } = useAuth();
  const [name, setName] = useState(q.clientName);
  const [phone, setPhone] = useState(q.phone);
  const [sourced, setSourced] = useState(false);
  const [timing, setTiming] = useState<'onAcceptance' | 'onCompletion'>('onAcceptance');
  const [rows, setRows] = useState<PaymentRow[]>(() => [newPaymentRow()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const payProblem = timing === 'onAcceptance' ? paymentProblem(rows, total) : null;
  const sourcingIncomplete = sourced && (!phone.trim() || !isNamedClient(name));

  async function submit() {
    if (busy || payProblem || sourcingIncomplete) return;
    setBusy(true);
    setErr('');
    const printWindow = window.open('', '_blank');
    try {
      const [order, company] = await Promise.all([
        api.post<OrderDetail>(`/costing/quotes/${q.id}/capture`, {
          customerName: name,
          phone,
          sourcedBy: sourced ? q.staffId : null,
          paymentTiming: timing,
          payments: timing === 'onAcceptance' ? toApiPayments(rows) : undefined,
        }),
        api.get<CompanySettings>('/master-data/settings'),
      ]);
      printOrderDocument(printWindow, order, company);
      await onDone();
    } catch (e) {
      printWindow?.close();
      setErr(e instanceof Error ? e.message : 'Could not capture the order');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="dialog blueprint" style={{ maxWidth: 560, width: '100%', maxHeight: '92vh', overflowY: 'auto', display: 'grid', gap: 'var(--space-3)' }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Capture {q.quoteNo} as an order</div>
        <p className="note" style={{ margin: 0 }}>
          {costingJobLabel(q.jobType)} · {q.summary} — <b>{fmtKsh(total)}</b> with VAT, the price agreed with the client.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Client name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>{sourced ? 'Phone *' : 'Phone (optional)'}</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" style={sourced && !phone.trim() ? { borderColor: 'var(--color-error)' } : undefined} />
          </div>
        </div>
        <SourcingField phone={phone} name={name} staffName={q.staffName || user?.name || ''} checked={sourced} onChange={setSourced} />
        <div className="field" style={{ margin: 0 }}>
          <label>Payment timing</label>
          <div className="seg" role="radiogroup">
            <label className={'seg-opt' + (timing === 'onAcceptance' ? ' checked' : '')}>
              <input type="radio" name="cqpay" checked={timing === 'onAcceptance'} onChange={() => setTiming('onAcceptance')} />
              Pay now
            </label>
            <label className={'seg-opt' + (timing === 'onCompletion' ? ' checked' : '')}>
              <input type="radio" name="cqpay" checked={timing === 'onCompletion'} onChange={() => setTiming('onCompletion')} />
              Pay on completion
            </label>
          </div>
        </div>
        {timing === 'onAcceptance' && (
          <div>
            <SplitPayments rows={rows} onChange={setRows} total={total} phone={phone} onPhoneChange={setPhone} accountReference={name || q.quoteNo} />
            {payProblem && <p className="note" style={{ color: 'var(--color-error)' }}>{payProblem}</p>}
          </div>
        )}
        {err && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary blueprint" disabled={busy || !!payProblem || sourcingIncomplete || !isNamedClient(name) && sourced} onClick={submit}>
            Capture order
          </button>
        </div>
      </div>
    </div>
  );
}
