import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../../api/client';
import { Loading, Notice, numStyle, useLoad } from './shared';

// Accounting → M-Pesa Matching → Split across orders: one M-Pesa payment (a customer paid several orders at once, straight to the Paybill) applied to several orders. The payer's own orders are listed
// first with a suggested split — the oldest orders filled first until the payment is used up — and a person edits the amounts and confirms. What is not given to an order stays on the receipt, waiting,
// with the amount that is left. Nothing is split by itself.

interface Info {
  id: number;
  receipt: string | null;
  amount: number;
  left: number;
  phone: string;
  payerName: string;
  applied: { orderNo: string; amount: number }[];
  orders: { orderId: number; ref: string; party: string; balance: number; date: string; samePayer: boolean }[];
  suggested: { orderId: number; amount: number }[];
}

const num = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(/,/g, '')) || 0);

export function SplitReceipt({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: (message: string) => void }) {
  const { data, error, loading } = useLoad<Info>(`/accounting/mpesa/${id}/split`);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (data) setAmounts(Object.fromEntries(data.suggested.map((s) => [s.orderId, String(s.amount)])));
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const visible = data.orders.filter((o) => showAll || o.samePayer || num(amounts[o.orderId] ?? '') > 0);
  const given = data.orders.reduce((a, o) => a + num(amounts[o.orderId] ?? ''), 0);
  const stays = Math.round((data.left - given) * 100) / 100;
  const over = data.orders.find((o) => num(amounts[o.orderId] ?? '') > o.balance + 1);
  const tooMuch = given > data.left + 1;
  const parts = data.orders.filter((o) => num(amounts[o.orderId] ?? '') > 0).map((o) => ({ orderId: o.orderId, amount: num(amounts[o.orderId] ?? '') }));

  async function confirm() {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ applied: number; remaining: number; orders: number }>(`/accounting/mpesa/${id}/allocate`, { allocations: parts });
      onDone(`${data!.receipt}: ${fmtKsh(r.applied)} applied to ${r.orders} order${r.orders === 1 ? '' : 's'}${r.remaining >= 1 ? `; ${fmtKsh(r.remaining)} still waiting on the receipt` : ''}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not apply the payment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
      <Notice error={err} />
      <p style={{ marginTop: 0 }}>
        <b>{data.receipt}</b> — {fmtKsh(data.amount)} from {data.payerName || data.phone}. <b>{fmtKsh(data.left)} is free to apply</b>
        {data.applied.length > 0 && <> (already on {data.applied.map((a) => `${a.orderNo} ${fmtKsh(a.amount)}`).join(', ')})</>}.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Raised</th>
              <th style={numStyle}>Owes</th>
              <th style={numStyle}>Apply (Ksh)</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted">No order from this payer owes anything. Show all open orders to choose another.</td>
              </tr>
            )}
            {visible.map((o) => (
              <tr key={o.orderId}>
                <td>{o.ref} {o.samePayer && <span className="tag tag-accent">same phone</span>}</td>
                <td>{o.party}</td>
                <td className="text-muted">{o.date}</td>
                <td style={numStyle}>{fmtKsh(o.balance)}</td>
                <td style={numStyle}>
                  <input
                    className="input"
                    style={{ width: 110, textAlign: 'right', ...(num(amounts[o.orderId] ?? '') > o.balance + 1 ? { borderColor: 'var(--color-error)' } : {}) }}
                    inputMode="decimal"
                    value={amounts[o.orderId] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [o.orderId]: e.target.value })}
                    placeholder="0"
                    aria-label={`Amount for ${o.ref}`}
                  />
                  {num(amounts[o.orderId] ?? '') === 0 && o.balance > 0 && data.left - given >= 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmounts({ ...amounts, [o.orderId]: String(Math.round(Math.min(o.balance, data.left - given) * 100) / 100) })}>fill</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 'var(--space-2) 0' }}>
        Applying <b>{fmtKsh(given)}</b> of {fmtKsh(data.left)}.{' '}
        {tooMuch ? <b style={{ color: 'var(--color-error)' }}>That is more than the payment holds.</b> : stays >= 1 ? <><b>{fmtKsh(stays)}</b> stays on the receipt, waiting.</> : 'The whole payment is used.'}
        {over && <b style={{ color: 'var(--color-error)' }}> {over.ref} owes less than the amount given to it.</b>}
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || parts.length === 0 || tooMuch || !!over} onClick={confirm}>
          Apply to {parts.length} order{parts.length === 1 ? '' : 's'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Only this payer’s orders' : 'Show all open orders'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
