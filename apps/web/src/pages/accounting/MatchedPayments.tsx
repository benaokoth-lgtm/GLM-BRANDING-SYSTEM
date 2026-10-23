import { Fragment, useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from './shared';

// Accounting → M-Pesa Matching → Matched payments: putting a wrong match right. A receipt that was matched to the wrong order can be MOVED to the right order (it must still owe that much) or taken OFF
// its order so it goes back to "Waiting to be matched". Either needs a reason and is logged with who did it. Open to the front office as well as Accounting.

interface Row {
  id: number;
  paymentId: number;
  /** What the whole receipt was, what is still free on it, and whether several orders share it. */
  receiptAmount: number;
  left: number;
  shared: boolean;
  receipt: string | null;
  kind: string;
  amount: number;
  phone: string;
  payerName: string;
  reference: string | null;
  date: string;
  orderId: number;
  orderNo: string;
  customer: string;
  matchedBy: string;
  canUnmatch: boolean;
  changes: { from: string; to: string | null; reason: string; by: string; at: string }[];
}

export function MatchedPayments({ openOrders, onChanged }: { openOrders: { orderId: number; ref: string; party: string; balance: number }[]; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const { data, error, loading, reload } = useLoad<{ rows: Row[] }>(`/accounting/mpesa/matched${term ? `?q=${encodeURIComponent(term)}` : ''}`);
  const [open, setOpen] = useState<{ id: number; mode: 'move' | 'off' } | null>(null); // id = the payment (one part of a receipt)
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const close = () => {
    setOpen(null);
    setTarget('');
    setReason('');
  };
  async function submit(r: Row) {
    if (!open) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      if (open.mode === 'move') {
        await api.post(`/accounting/mpesa/${r.id}/rematch`, { orderId: Number(target), reason, paymentId: r.paymentId });
        setMsg(`${r.receipt ?? 'The payment'} moved from ${r.orderNo} to ${openOrders.find((o) => o.orderId === Number(target))?.ref ?? 'the other order'}.`);
      } else {
        await api.post(`/accounting/mpesa/${r.id}/unmatch`, { reason, paymentId: r.paymentId });
        setMsg(`${r.receipt ?? 'The payment'} taken off ${r.orderNo}. It is back under “Waiting to be matched”.`);
      }
      close();
      reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change the match');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Matched payments — put a wrong match right" hint="Matched a payment to the wrong order? Move it to the right order, or take it off so it goes back to waiting. Every change is logged with who made it and why.">
      <Notice error={err} message={msg} />
      <form
        className="no-print"
        style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="mp-q">Find a payment</label>
          <input id="mp-q" className="input" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="receipt code, phone, payer or order number" />
        </div>
        <button type="submit" className="btn btn-secondary btn-sm">Search</button>
        {term && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setTerm(''); }}>Clear</button>}
      </form>
      <Loading loading={loading} error={error} />
      {data && data.rows.length === 0 && <p className="note">No matched payments{term ? ' found for that search' : ''}.</p>}
      {data && data.rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Date</th>
                <th>Paid by</th>
                <th>Matched to</th>
                <th style={numStyle}>Amount</th>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Fragment key={r.paymentId}>
                  <tr>
                    <td>
                      {r.receipt ?? '—'} {r.kind === 'STK' ? <Tag>push</Tag> : null}
                    </td>
                    <td className="text-muted">{fmtDate(r.date)}</td>
                    <td>
                      {r.payerName || '—'}
                      <div className="text-muted" style={{ fontSize: 12 }}>{r.phone}{r.reference ? ` · ${r.reference}` : ''}</div>
                    </td>
                    <td>
                      <b>{r.orderNo}</b> <span className="text-muted">{r.customer}</span>
                      {r.shared && <div className="text-muted" style={{ fontSize: 12 }}>part of a Ksh {Math.round(r.receiptAmount).toLocaleString('en-KE')} payment shared by several orders{r.left >= 1 ? ` — Ksh ${Math.round(r.left).toLocaleString('en-KE')} still free` : ''}</div>}
                      {r.matchedBy && <div className="text-muted" style={{ fontSize: 12 }}>{r.matchedBy}</div>}
                      {r.changes.map((c, i) => (
                        <div key={i} className="text-muted" style={{ fontSize: 12 }}>
                          {c.to ? `moved from ${c.from} to ${c.to}` : `taken off ${c.from}`} by {c.by} — {c.reason}
                        </div>
                      ))}
                    </td>
                    <td style={numStyle}>{fmtKsh(r.amount)}</td>
                    <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { close(); setOpen({ id: r.paymentId, mode: 'move' }); }}>Move…</button>{' '}
                      {r.canUnmatch && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { close(); setOpen({ id: r.paymentId, mode: 'off' }); }}>Take off…</button>}
                    </td>
                  </tr>
                  {open?.id === r.paymentId && (
                    <tr>
                      <td colSpan={6}>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end', padding: 'var(--space-2) 0' }}>
                          {open.mode === 'move' && (
                            <div className="field" style={{ margin: 0 }}>
                              <label>Move it to</label>
                              <select className="input" style={{ minWidth: 280 }} value={target} onChange={(e) => setTarget(e.target.value)}>
                                <option value="">Choose the right order…</option>
                                {openOrders
                                  .filter((o) => o.orderId !== r.orderId && o.balance + 1 >= r.amount)
                                  .map((o) => (
                                    <option key={o.orderId} value={o.orderId}>
                                      {o.ref} — {o.party} (owes {fmtKsh(o.balance)})
                                    </option>
                                  ))}
                              </select>
                            </div>
                          )}
                          <div className="field" style={{ margin: 0, flex: '1 1 260px' }}>
                            <label>Why? (required)</label>
                            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={open.mode === 'move' ? 'e.g. customer paid for W-1020, not W-1002' : 'e.g. paid by someone else; will match later'} />
                          </div>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !reason.trim() || (open.mode === 'move' && !target)} onClick={() => submit(r)}>
                            {open.mode === 'move' ? 'Move the payment' : 'Take it off the order'}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
                        </div>
                        {open.mode === 'move' && <p className="note" style={{ margin: 0 }}>Only orders that still owe at least {fmtKsh(r.amount)} are listed.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
