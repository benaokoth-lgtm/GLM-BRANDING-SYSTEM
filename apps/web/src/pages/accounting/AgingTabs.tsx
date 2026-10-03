import { useState } from 'react';
import { fmtDate } from '@glm/shared';
import { AsOfBar, Card, Loading, Tag, money, numStyle, printPage, useLoad, ymd } from './shared';

interface Bucket {
  bucket: string;
  total: number;
}

function Buckets({ buckets, total }: { buckets: Bucket[]; total: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${buckets.length + 1}, 1fr)`, gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
      {buckets.map((b) => (
        <div key={b.bucket} className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">{b.bucket}</div>
          <div className="card-title">{money(b.total)}</div>
        </div>
      ))}
      <div className="card blueprint elev-sm" style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}>
        <div className="card-kicker" style={{ color: 'var(--color-bg)' }}>
          Total
        </div>
        <div className="card-title">{money(total)}</div>
      </div>
    </div>
  );
}

const bucketTone = (b: string) => (b === 'Not yet due' ? 'neutral' : b === '0–30 days' ? 'neutral' : 'bad') as 'good' | 'bad' | 'neutral';

// ── Accounts receivable ──
interface ArData {
  asOf: string;
  rows: { orderId: number; ref: string; party: string; status: string; date: string; dueDate: string | null; amount: number; paid: number; adjustments: number; outstanding: number; ageDays: number; bucket: string }[];
  total: number;
  byBucket: Bucket[];
  overpaidCredits: number;
}

export function ReceivablesTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading } = useLoad<ArData>(`/accounting/receivables?asOf=${asOf}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <Buckets buckets={data.byBucket} total={data.total} />
          <Card
            title="Accounts Receivable"
            hint="What customers still owe, aged from the invoice due date (or the order date when none was set). The amount is the sale plus debit notes, less payments and credit notes."
            actions={
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th style={numStyle}>Amount</th>
                  <th style={numStyle}>Paid</th>
                  <th style={numStyle}>Notes</th>
                  <th style={numStyle}>Owing</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      Nobody owes anything.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.orderId}>
                    <td>{r.ref}</td>
                    <td>{r.party}</td>
                    <td className="text-muted">{fmtDate(r.date)}</td>
                    <td className="text-muted">{r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                    <td style={numStyle}>{money(r.amount)}</td>
                    <td style={numStyle}>{money(r.paid)}</td>
                    <td style={numStyle}>{money(r.adjustments)}</td>
                    <td style={{ ...numStyle, fontWeight: 700 }}>{money(r.outstanding)}</td>
                    <td>
                      <Tag tone={bucketTone(r.bucket)}>{r.bucket}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Math.abs(data.overpaidCredits) > 0.004 && <p className="note">Customers have also been credited or overpaid {money(-data.overpaidCredits)} in total — shown under Customer Deposits &amp; Credits on the balance sheet.</p>}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Accounts payable ──
interface ApData {
  asOf: string;
  rows: { id: number; date: string; dueDate: string | null; supplier: string; head: string; invoice: string | null; amount: number; paidAmount: number; credited: number; outstanding: number; ageDays: number; bucket: string }[];
  total: number;
  byBucket: Bucket[];
}

export function PayablesTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading } = useLoad<ApData>(`/accounting/payables?asOf=${asOf}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <Buckets buckets={data.byBucket} total={data.total} />
          <Card
            title="Accounts Payable"
            hint="What the business still owes suppliers: expenses recorded “on credit”, less payments and supplier debit notes. Record a bill under Finance → Expenses (Paid by → On credit) and pay it there with the Pay button."
            actions={
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Expense</th>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th style={numStyle}>Bill</th>
                  <th style={numStyle}>Paid</th>
                  <th style={numStyle}>Credited</th>
                  <th style={numStyle}>Owing</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="text-muted">
                      No supplier bills outstanding.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.supplier || '—'}</td>
                    <td className="text-muted">{r.head}</td>
                    <td className="text-muted">{r.invoice || '—'}</td>
                    <td className="text-muted">{fmtDate(r.date)}</td>
                    <td className="text-muted">{r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                    <td style={numStyle}>{money(r.amount)}</td>
                    <td style={numStyle}>{money(r.paidAmount)}</td>
                    <td style={numStyle}>{money(r.credited)}</td>
                    <td style={{ ...numStyle, fontWeight: 700 }}>{money(r.outstanding)}</td>
                    <td>
                      <Tag tone={bucketTone(r.bucket)}>{r.bucket}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
