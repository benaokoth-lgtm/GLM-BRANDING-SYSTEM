import { useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../../api/client';
import { StkCollectDialog, StkRowButton, useMayCollect } from '../../components/StkCollect';
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
  rows: { orderId: number; ref: string; party: string; status: string; date: string; dueDate: string | null; amount: number; paid: number; adjustments: number; outstanding: number; ageDays: number; bucket: string; salesPersonId: number; salesPersonName: string; responsibleId: number; responsibleName: string; reassigned: boolean }[];
  total: number;
  byBucket: Bucket[];
  byPerson: { id: number; name: string; total: number; count: number; overdue: number }[];
  staff: { id: number; name: string }[];
  overpaidCredits: number;
}

export function ReceivablesTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading, reload } = useLoad<ArData>(`/accounting/receivables?asOf=${asOf}`);
  // who is responsible for collecting: the sales person the sale is credited to, unless Accounting hands the balance to someone else
  const [who, setWho] = useState<number | 'all'>('all');
  const [changing, setChanging] = useState<number | null>(null);
  // an M-Pesa prompt to the customer for what they owe on an invoice
  const mayCollect = useMayCollect();
  const [stkId, setStkId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  async function hand(orderId: number, staffId: number | null) {
    setBusy(true);
    setSaveError('');
    try {
      await api.put(`/accounting/receivables/${orderId}/collector`, { staffId });
      setChanging(null);
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not change who collects it');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <Buckets buckets={data.byBucket} total={data.total} />
          {data.byPerson.length > 0 && (
            <Card title="Who is responsible for collecting" hint="The balance each person has to collect from customers: the sales person a sale is credited to, even when someone else keyed it, unless the balance was handed to another person. Choose a name to see only theirs.">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className={'btn btn-sm ' + (who === 'all' ? 'btn-primary' : 'btn-secondary')} onClick={() => setWho('all')}>
                  Everyone · {money(data.total)}
                </button>
                {data.byPerson.map((p) => (
                  <button key={p.id} type="button" className={'btn btn-sm ' + (who === p.id ? 'btn-primary' : 'btn-secondary')} onClick={() => setWho(p.id)} title={`${p.count} ${p.count === 1 ? 'invoice' : 'invoices'}${p.overdue > 0 ? `, ${money(p.overdue)} past its due date` : ''}`}>
                    {p.name} · {money(p.total)}
                  </button>
                ))}
              </div>
            </Card>
          )}
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
                  <th>Responsible for collection</th>
                  <th>Age</th>
                  {mayCollect && <th className="no-print"></th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="text-muted">
                      Nobody owes anything.
                    </td>
                  </tr>
                )}
                {data.rows.filter((r) => who === 'all' || r.responsibleId === who).map((r) => (
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
                      {changing === r.orderId ? (
                        <span className="no-print" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select className="input" style={{ width: 170 }} defaultValue={r.responsibleId} disabled={busy} onChange={(e) => hand(r.orderId, Number(e.target.value))} aria-label={`Who collects ${r.ref}`}>
                            {data.staff.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}{p.id === r.salesPersonId ? ' (the sales person)' : ''}
                              </option>
                            ))}
                          </select>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChanging(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <b>{r.responsibleName}</b>
                          {r.reassigned && <div className="text-muted" style={{ fontSize: 12 }}>handed over · sold by {r.salesPersonName}</div>}
                          <button type="button" className="btn btn-ghost btn-sm no-print" style={{ marginLeft: 4 }} onClick={() => { setSaveError(''); setChanging(r.orderId); }} title="Hand the collection to someone else">Change</button>
                          {r.reassigned && (
                            <button type="button" className="btn btn-ghost btn-sm no-print" disabled={busy} onClick={() => hand(r.orderId, null)} title="Back to the sales person">Reset</button>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <Tag tone={bucketTone(r.bucket)}>{r.bucket}</Tag>
                    </td>
                    {mayCollect && <td className="no-print">{r.outstanding > 0.005 && <StkRowButton onOpen={() => setStkId(r.orderId)} />}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {saveError && <p className="note" style={{ color: 'var(--color-error)' }}>{saveError}</p>}
            {Math.abs(data.overpaidCredits) > 0.004 && <p className="note">Customers have also been credited or overpaid {money(-data.overpaidCredits)} in total — shown under Customer Deposits &amp; Credits on the balance sheet.</p>}
          </Card>
        </>
      )}
      {stkId && (
        <StkCollectDialog
          orderId={stkId}
          onClose={() => setStkId(null)}
          onPaid={() => {
            setStkId(null);
            reload();
          }}
        />
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
