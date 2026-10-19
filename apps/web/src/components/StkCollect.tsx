import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { OrderDetail } from '../api/models';
import { useAuth } from '../state/AuthContext';
import MpesaStkButton from './MpesaStkButton';

// "Ask the customer to pay by M-Pesa now": an STK push against an existing order, from wherever a balance is owed (All Orders, the order, Accounts Receivable, the production lists).
// It goes through NCBA when that is switched on (Master Data → NCBA), else Safaricom. The push is raised against the ORDER, so when the customer pays the payment is recorded on it by
// the server — there is no separate "Record payment" step. The phone and the amount can be changed here (the order's own phone is filled in when there is one).

/** Who may start one from a list: the server still decides for each order (an order is only collected by someone allowed to take payments on it). */
export function useMayCollect(): boolean {
  const { user } = useAuth();
  return user?.role === 'Admin' || !!user?.permissions.canManagePayments;
}

export function StkCollectPanel({ orderId, orderNo, balanceDue, phone, onPaid }: { orderId: number; orderNo: string; balanceDue: number; phone: string; onPaid: () => void }) {
  const [ph, setPh] = useState(phone);
  // M-Pesa takes whole shillings
  const [amount, setAmount] = useState(String(Math.round(balanceDue)));
  const [paid, setPaid] = useState(false);
  const amt = Number(amount.replace(/[^\d.]/g, '')) || 0;
  const problem = amt <= 0 ? 'Enter the amount to ask for.' : amt > Math.ceil(balanceDue) ? `This order only has ${fmtKsh(balanceDue)} still to pay.` : !ph.trim() ? 'Enter the customer’s M-Pesa phone number.' : '';

  if (paid) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <span className="tag tag-accent">Paid — {fmtKsh(amt)} is recorded on {orderNo}</span>
        <div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onPaid}>Done</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ margin: 0, width: 190 }}>
          <label>Customer’s M-Pesa number</label>
          <input className="input" inputMode="tel" placeholder="07xx xxx xxx" value={ph} onChange={(e) => setPh(e.target.value)} aria-label="Customer’s M-Pesa number" />
        </div>
        <div className="field" style={{ margin: 0, width: 140 }}>
          <label>Amount (Ksh)</label>
          <input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} aria-label="Amount to ask for" />
        </div>
      </div>
      <MpesaStkButton phone={ph} amount={amt} accountReference={orderNo} description={`Payment for ${orderNo}`} orderId={orderId} disabled={!!problem} onSuccess={() => setPaid(true)} />
      {problem && <p className="note" style={{ margin: 0 }}>{problem}</p>}
      <p className="note" style={{ margin: 0 }}>The customer gets a prompt on their phone and enters their M-Pesa PIN. When they pay, the payment is recorded on the order by itself.</p>
    </div>
  );
}

/** The same, in its own dialog, opened from a list: it loads the order for its phone, balance and whether this person may take payments on it. */
export function StkCollectDialog({ orderId, onClose, onPaid }: { orderId: number; onClose: () => void; onPaid: () => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<OrderDetail>(`/orders/${orderId}`).then(setDetail).catch((e) => setError(e instanceof Error ? e.message : 'Could not open the order'));
  }, [orderId]);
  const client = detail ? (detail.kind === 'corporate' ? detail.corporateClient?.name : detail.customerName) || '—' : '';
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 520, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 'var(--space-3)' }}>
          <div>
            <div className="card-kicker">Collect by M-Pesa</div>
            {detail && (
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>
                {detail.orderNo} · {client}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
        {!detail && !error && <p className="note">Loading…</p>}
        {detail && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <div style={{ marginBottom: 'var(--space-3)' }}>
              Balance due: <b>{fmtKsh(detail.totals.balanceDue)}</b>
            </div>
            {detail.totals.balanceDue <= 0.005 ? (
              <p className="note">Nothing is owed on this order.</p>
            ) : detail.canTakePayment === false ? (
              <p className="note" style={{ color: 'var(--color-error)' }}>You may not take payments on this order. Ask someone who handles payments.</p>
            ) : (
              <StkCollectPanel orderId={detail.id} orderNo={detail.orderNo} balanceDue={detail.totals.balanceDue} phone={detail.phone || detail.corporateClient?.phone || ''} onPaid={onPaid} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The small button for a list row (it does not open the row behind it). */
export function StkRowButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm no-print"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title="Send the customer an M-Pesa prompt for what they owe"
    >
      📲 STK push
    </button>
  );
}
