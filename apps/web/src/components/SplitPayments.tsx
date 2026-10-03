import { fmtKsh } from '@glm/shared';
import type { PaymentMethod } from '@glm/shared';
import MpesaStkButton from './MpesaStkButton';

// Taking payment for an order, in as many parts as the customer likes — say Ksh 2,000 cash and Ksh 3,000 M-Pesa. Every
// part is its own payment line, so each method reconciles to its own account. An M-Pesa part needs proof: either the
// M-Pesa receipt code (also how it is matched to the M-Pesa statement later) or a successful STK push.

export interface PaymentRow {
  key: number;
  method: PaymentMethod;
  amount: string;
  reference: string;
  /** M-Pesa only: an STK push (or staff confirmation) succeeded, so no code needs typing. */
  confirmed: boolean;
}

export const METHODS: PaymentMethod[] = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'];
let nextKey = 1;
export const newPaymentRow = (method: PaymentMethod = 'Cash', amount = ''): PaymentRow => ({ key: nextKey++, method, amount, reference: '', confirmed: false });

const num = (v: string) => Number(v) || 0;
export const paymentsTotal = (rows: PaymentRow[]) => rows.reduce((a, r) => a + num(r.amount), 0);

/** Why these rows can't be submitted yet, or null when they're fine. */
export function paymentProblem(rows: PaymentRow[], total: number): string | null {
  const paying = paymentsTotal(rows);
  if (paying > total + 0.01) return `The payments add up to ${fmtKsh(paying)}, more than the ${fmtKsh(total)} due`;
  for (const r of rows) {
    if (num(r.amount) > 0 && r.method === 'M-Pesa' && !r.confirmed && !r.reference.trim()) return 'Enter the M-Pesa receipt code (or send an STK push) for the M-Pesa part';
  }
  return null;
}

/** The lines the API expects: only rows with an amount. */
export function toApiPayments(rows: PaymentRow[]) {
  return rows
    .filter((r) => num(r.amount) > 0)
    .map((r) => ({ method: r.method, amount: num(r.amount), reference: r.reference.trim() || null }));
}

export default function SplitPayments({
  rows,
  onChange,
  total,
  phone,
  accountReference,
}: {
  rows: PaymentRow[];
  onChange: (rows: PaymentRow[]) => void;
  /** What is due — the order total, or the balance still owing. */
  total: number;
  phone?: string;
  accountReference?: string;
}) {
  const paying = paymentsTotal(rows);
  const remaining = Math.max(0, total - paying);
  const set = (key: number, patch: Partial<PaymentRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {rows.map((r, i) => (
        <div key={r.key} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gridTemplateColumns: '1.1fr 1fr 1.3fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div className="field">
            <label>{rows.length > 1 ? `Payment ${i + 1} — method` : 'Method'}</label>
            <select className="input" value={r.method} onChange={(e) => set(r.key, { method: e.target.value as PaymentMethod, confirmed: false, reference: '' })}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Amount (Ksh)</label>
            <input className="input" inputMode="decimal" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value, confirmed: false })} placeholder="0" />
          </div>
          <div className="field">
            <label>{r.method === 'M-Pesa' ? 'M-Pesa receipt code' : r.method === 'Cash' ? 'Reference (optional)' : 'Slip / reference (optional)'}</label>
            <input
              className="input"
              value={r.reference}
              onChange={(e) => set(r.key, { reference: e.target.value.toUpperCase(), confirmed: false })}
              placeholder={r.method === 'M-Pesa' ? 'e.g. SGH1A2B3C4' : ''}
              disabled={r.method === 'Cash'}
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {remaining > 0 && num(r.amount) === 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set(r.key, { amount: String(Math.round(remaining * 100) / 100) })}>
                Rest
              </button>
            )}
            {rows.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(rows.filter((x) => x.key !== r.key))} aria-label="Remove this payment">
                ✕
              </button>
            )}
          </div>

          {r.method === 'M-Pesa' && num(r.amount) > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              {r.confirmed ? (
                <span className="tag tag-accent">M-Pesa payment confirmed{r.reference ? ` (${r.reference})` : ''}</span>
              ) : (
                <>
                  <MpesaStkButton
                    phone={phone || ''}
                    amount={num(r.amount)}
                    accountReference={accountReference || 'Order'}
                    description="Order payment"
                    onSuccess={(receipt) => set(r.key, { confirmed: true, reference: receipt || r.reference })}
                  />
                  <p className="note" style={{ marginTop: 'var(--space-2)' }}>
                    {phone ? 'Or type the receipt code from the customer’s M-Pesa SMS above — it is how the payment is matched to your M-Pesa statement.' : 'No phone number, so no STK push — type the receipt code from the customer’s M-Pesa SMS above.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {rows.length < 6 ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...rows, newPaymentRow(rows.some((r) => r.method === 'Cash') ? 'M-Pesa' : 'Cash')])}>
            + Add another method
          </button>
        ) : (
          <span />
        )}
        <span style={{ fontSize: 13 }}>
          Paying now <strong>{fmtKsh(paying)}</strong> · {total - paying > 0.01 ? <>balance after this <strong>{fmtKsh(remaining)}</strong></> : 'settled in full'}
        </span>
      </div>
    </div>
  );
}
