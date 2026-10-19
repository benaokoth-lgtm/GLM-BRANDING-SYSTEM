import { useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Loading, Notice, Tag, money, numStyle, useLoad } from './shared';

interface Suggestion {
  orderId: number;
  ref: string;
  party: string;
  balance: number;
  best: boolean;
}
interface Row {
  id: number;
  receipt: string | null;
  kind: string;
  status: 'Unmatched' | 'Applied' | 'Dismissed';
  amount: number;
  phone: string;
  payerName: string;
  reference: string | null;
  receivedOn: string | null;
  appliedTo: string | null;
  appliedByName: string | null;
  dismissedNote: string | null;
  suggestions: Suggestion[];
  note: string | null;
}
interface Data {
  rows: Row[];
  summary: { unmatchedCount: number; unmatchedTotal: number };
  openOrders: { orderId: number; ref: string; party: string; balance: number }[];
  unverifiedPayments: { id: number; orderNo: string; date: string; amount: number }[];
}

const FILTERS = [
  ['Unmatched', 'Waiting to be matched'],
  ['Applied', 'Matched'],
  ['Dismissed', 'Dismissed'],
  ['all', 'All'],
] as const;

// M-Pesa payment matching. Money that reaches the Paybill/Till — or an uploaded M-Pesa statement — is booked the day it
// arrives and waits here until it is matched to the order it paid for. A payment whose reference names an order number is
// matched automatically; the rest are matched by a person, with suggestions.
export function MpesaTab() {
  const [filter, setFilter] = useState<string>('Unmatched');
  const { data, error, loading, reload } = useLoad<Data>(`/accounting/mpesa?status=${filter}`);
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [dismissNote, setDismissNote] = useState('');

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const importStatement = () =>
    run(async () => {
      const r = await api.post<{ read: number; added: number; duplicates: number; linkedToRecorded: number; autoApplied: number; skipped: number }>('/accounting/mpesa/import', { text: csv });
      setCsv('');
      return `Read ${r.read} payment(s): ${r.autoApplied} matched automatically, ${r.linkedToRecorded} tied to payments you had already recorded, ${r.added - r.autoApplied} waiting for you, ${r.duplicates} already known.`;
    });

  const apply = (id: number, orderId: number) =>
    run(async () => {
      await api.post(`/accounting/mpesa/${id}/apply`, { orderId });
      return 'Payment matched to the order';
    });

  async function onFile(file: File | undefined) {
    if (file) setCsv(await file.text());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Notice error={err || error} message={msg} />

      <Card
        title="Upload an M-Pesa statement"
        hint="Download the statement (CSV) from the M-Pesa portal or Safaricom Business app and drop it here — or paste it. Only money received is read. Receipts already on file are skipped, so uploading overlapping statements is safe."
      >
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} className="no-print" />
        <textarea className="input" style={{ marginTop: 'var(--space-2)', minHeight: 100, fontFamily: 'monospace', fontSize: 12 }} placeholder="Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <button type="button" className="btn btn-primary" disabled={busy || csv.trim().length < 10} onClick={importStatement}>
            Read statement &amp; match
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(async () => `${(await api.post<{ applied: number }>('/accounting/mpesa/auto-match', {})).applied} payment(s) matched on order number`)}>
            Re-run automatic matching
          </button>
        </div>
      </Card>

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="card blueprint elev-sm">
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-kicker">Waiting to be matched</div>
            <div className="card-title">
              {data.summary.unmatchedCount} · {fmtKsh(data.summary.unmatchedTotal)}
            </div>
            <div className="note">Held in “Unallocated M-Pesa Receipts” until matched.</div>
          </div>
          <div className="card blueprint elev-sm">
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-kicker">M-Pesa payments with no receipt code</div>
            <div className="card-title">{data.unverifiedPayments.length}</div>
            <div className="note">Recorded on an order without the M-Pesa code, so they can’t be checked against the statement.</div>
          </div>
        </div>
      )}

      <Card title="M-Pesa payments received">
        <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className={'btn btn-sm ' + (filter === id ? 'btn-primary' : 'btn-secondary')} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <Loading loading={loading} error="" />
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Receipt</th>
              <th>From</th>
              <th>Reference they typed</th>
              <th style={numStyle}>Amount</th>
              <th>Status / match</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted">
                  Nothing here.
                </td>
              </tr>
            )}
            {(data?.rows ?? []).map((r) => (
              <tr key={r.id}>
                <td className="text-muted">{r.receivedOn ? fmtDate(r.receivedOn) : '—'}</td>
                <td>
                  <strong>{r.receipt}</strong>
                  <div className="note">{r.kind === 'C2B' ? 'Paybill / Till' : 'Statement'}</div>
                </td>
                <td>
                  {r.payerName || '—'}
                  <div className="note">{r.phone}</div>
                </td>
                <td className="text-muted" style={{ maxWidth: 220, fontSize: 12 }}>
                  {r.reference || '—'}
                </td>
                <td style={{ ...numStyle, fontWeight: 700 }}>{money(r.amount)}</td>
                <td>
                  {r.status === 'Applied' && (
                    <>
                      <Tag tone="good">Matched</Tag> {r.appliedTo}
                      <div className="note">{r.appliedByName}</div>
                    </>
                  )}
                  {r.status === 'Dismissed' && (
                    <>
                      <Tag>Dismissed</Tag>
                      <div className="note">{r.dismissedNote}</div>
                    </>
                  )}
                  {r.status === 'Unmatched' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      {r.suggestions.slice(0, 3).map((s) => (
                        <button key={s.orderId} type="button" className={'btn btn-sm ' + (s.best ? 'btn-primary' : 'btn-secondary')} disabled={busy} onClick={() => apply(r.id, s.orderId)}>
                          {s.best ? 'Best match: ' : ''}
                          {s.ref} · {s.party} · owes {fmtKsh(s.balance)}
                        </button>
                      ))}
                      {r.note && <div className="note">{r.note}</div>}
                      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        <select className="input" style={{ width: 'auto' }} value={pick[r.id] ?? ''} onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.value }))}>
                          <option value="">Other order…</option>
                          {(data?.openOrders ?? []).map((o) => (
                            <option key={o.orderId} value={o.orderId}>
                              {o.ref} — {o.party} (owes {fmtKsh(o.balance)})
                            </option>
                          ))}
                        </select>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !pick[r.id]} onClick={() => apply(r.id, Number(pick[r.id]))}>
                          Match
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setDismissing(r.id); setDismissNote(''); }}>
                          Dismiss
                        </button>
                      </div>
                      {dismissing === r.id && (
                        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                          <input className="input" placeholder="Why? (e.g. sent in error, not ours)" value={dismissNote} onChange={(e) => setDismissNote(e.target.value)} />
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy || !dismissNote.trim()}
                            onClick={() =>
                              run(async () => {
                                await api.post(`/accounting/mpesa/${r.id}/dismiss`, { note: dismissNote });
                                setDismissing(null);
                                return 'Payment dismissed';
                              })
                            }
                          >
                            Confirm
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {data && data.unverifiedPayments.length > 0 && (
        <Card title="M-Pesa payments recorded without a receipt code" hint="Open the order and note the code from the customer’s M-Pesa SMS, or match against the statement above by amount and date.">
          <table className="table">
            <tbody>
              {data.unverifiedPayments.map((p) => (
                <tr key={p.id}>
                  <td>{p.orderNo}</td>
                  <td className="text-muted">{fmtDate(p.date)}</td>
                  <td style={numStyle}>{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
