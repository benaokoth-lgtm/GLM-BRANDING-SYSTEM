import { useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Card, Loading, Notice, Pager, Tag, useLoad } from '../pages/accounting/shared';

// What NCBA has sent: the payments NCBA told us about on the Paybill, and what became of each. Shown in Master Data → NCBA and in Accounting beside M-Pesa Matching. A payment NCBA reports is booked
// to the Bank account as it arrives (NCBA settles the Paybill into the bank account itself); one with no prompt is then matched to an order in M-Pesa Matching. A notification whose signature did not
// check out is HELD, not booked, until an Admin has checked the payment in the NCBA account and accepts it.

interface Received {
  id: number;
  receivedAt: string;
  transId: string;
  amount: number;
  billRef: string;
  phone: string;
  payerName: string;
  outcome: string;
  note: string;
}

const OUTCOME_TONE: Record<string, 'good' | 'neutral' | 'bad'> = { Matched: 'good', Received: 'good', Duplicate: 'neutral', Held: 'bad', Rejected: 'bad' };
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });

interface Page {
  rows: Received[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  held: number;
}

export default function NcbaActivity({ onChanged }: { onChanged?: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const log = useLoad<Page>(`/ncba/notifications?page=${page}&pageSize=${pageSize}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function accept(n: Received) {
    if (!window.confirm(`Book ${fmtKsh(n.amount)} (${n.transId}) from ${n.payerName || 'an unknown payer'}? Do this only after checking the payment really arrived in the NCBA account.`)) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.post(`/ncba/notifications/${n.id}/accept`, {});
      setMsg(`${n.transId} was booked`);
      log.reload();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not book it');
    } finally {
      setBusy(false);
    }
  }

  const held = log.data?.held ?? 0;
  const shown = log.data;
  return (
    <Card title="What NCBA has sent" hint="The payments NCBA told us about, newest first, and what became of each.">
      <Notice error={err} message={msg} />
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => log.reload()}>
          Refresh
        </button>
        {held > 0 && <Tag tone="bad">{held} held for an Admin to check</Tag>}
      </div>
      {!log.data ? (
        <Loading loading={log.loading} error={log.error} />
      ) : log.data.total === 0 ? (
        <p className="note">Nothing yet. Once NCBA is told the address and credentials, every payment shows up here.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Receipt</th>
                <th>From</th>
                <th>Reference</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {log.data.rows.map((n) => (
                <tr key={n.id}>
                  <td className="text-muted">{when(n.receivedAt)}</td>
                  <td>{n.transId || '—'}</td>
                  <td>
                    {n.payerName || '—'}
                    {n.phone && <div className="text-muted">{n.phone}</div>}
                  </td>
                  <td className="text-muted">{n.billRef || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(n.amount)}</td>
                  <td title={n.note}>
                    <Tag tone={OUTCOME_TONE[n.outcome] ?? 'neutral'}>{n.outcome}</Tag>
                    {n.outcome === 'Held' && isAdmin && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => accept(n)}>
                        Accept
                      </button>
                    )}
                    {n.note && <div className="text-muted" style={{ fontSize: 11 }}>{n.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown && <Pager info={shown} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />}
      <p className="note">
        <b>Matched</b> is the answer to an STK push; <b>Received</b> is a payment made straight to the Paybill, to be matched to an order under M-Pesa Matching. <b>Held</b> means the signature on the notification did not check
        out, so nothing was booked: check the payment in your NCBA account and, if it is real, an Admin accepts it. <b>Rejected</b> means the username or password was not yours.
      </p>
    </Card>
  );
}
