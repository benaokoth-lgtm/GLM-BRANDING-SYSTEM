import { useEffect, useState } from 'react';
import { EXPENSE_METHODS, fmtDate, fmtKsh, priceFromCost } from '@glm/shared';
import { api } from '../api/client';
import { Notice, Tag, useLoad } from '../pages/accounting/shared';

// The costing of a contracted-out job — only ever shown to people who can see costs (the server refuses everyone else). It holds the
// supplier's quote and mark-up per line, the supplier's bills (paid in full, or with a deposit and the balance owing), and the profit.

interface Costing {
  orderId: number;
  orderNo: string;
  lines: { lineId: number; service: string; qty: number; unitPrice: number; sale: number; supplierName: string; supplierCost: number | null; markupType: string | null; markupValue: number | null; estimatedCost: number | null; needsCosting: boolean }[];
  bills: { id: number; date: string; supplier: string; invoiceNumber: string | null; note: string; amount: number; paid: number; owing: number; dueDate: string | null }[];
  sale: number;
  estimatedCost: number;
  billed: number;
  paid: number;
  owing: number;
  costBasis: string;
  unbilledQuote: number;
  margin: { sale: number; cost: number; markupPct: number | null; marginPct: number | null; grossProfit: number; saleExVat: number; bookProfit: number; bookMarginPct: number | null };
}

export default function OutsourcedCostingPanel({ orderId, onChanged }: { orderId: number; onChanged: () => void }) {
  const { data, error, reload } = useLoad<Costing>(`/orders/${orderId}/costing`);
  const [edits, setEdits] = useState<Record<number, { cost: string; type: 'percent' | 'amount'; value: string; supplier: string }>>({});
  const [bill, setBill] = useState({ supplierName: '', amount: '', paidNow: '', method: 'Bank Transfer', invoiceNumber: '', dueDate: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEdits(
      Object.fromEntries(
        data.lines.map((l) => [l.lineId, { cost: l.supplierCost != null ? String(l.supplierCost) : '', type: (l.markupType === 'amount' ? 'amount' : 'percent') as 'percent' | 'amount', value: l.markupValue != null ? String(l.markupValue) : '', supplier: l.supplierName }]),
      ),
    );
    setBill((b) => ({ ...b, supplierName: b.supplierName || data.lines[0]?.supplierName || '', amount: b.amount || (data.unbilledQuote > 0 ? String(data.unbilledQuote) : '') }));
  }, [data]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p> : null;

  const saveQuotes = () =>
    run(async () => {
      await api.put(`/orders/${orderId}/costing`, {
        lines: data.lines.map((l) => {
          const e = edits[l.lineId]!;
          const cost = Number(e.cost);
          return { lineId: l.lineId, supplierCost: cost > 0 ? cost : null, markupType: e.type, markupValue: Number(e.value) || 0, supplierName: e.supplier || null };
        }),
      });
      return 'Supplier quote saved';
    });

  const recordBill = () =>
    run(async () => {
      await api.post(`/orders/${orderId}/supplier-bills`, {
        supplierName: bill.supplierName,
        amount: Number(bill.amount),
        paidNow: Number(bill.paidNow) || 0,
        method: bill.method,
        invoiceNumber: bill.invoiceNumber || undefined,
        dueDate: bill.dueDate || undefined,
      });
      setBill((b) => ({ ...b, amount: '', paidNow: '', invoiceNumber: '', dueDate: '' }));
      return 'Supplier bill recorded';
    });

  const m = data.margin;
  const anyNeeds = data.lines.some((l) => l.needsCosting);

  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
      <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
        Contracted-out costing — visible only to people who can see costs {anyNeeds && <Tag tone="bad">needs the supplier's quote</Tag>}
      </div>
      <Notice error={err} message={msg} />

      <table className="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Supplier</th>
            <th style={{ textAlign: 'right' }}>Qty</th>
            <th>Supplier price / unit (VAT incl.)</th>
            <th>Mark-up</th>
            <th style={{ textAlign: 'right' }}>Sold at / unit</th>
            <th style={{ textAlign: 'right' }}>Quote total</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => {
            const e = edits[l.lineId];
            if (!e) return null;
            const suggested = Number(e.cost) > 0 ? priceFromCost(Number(e.cost), e.type, Number(e.value) || 0) : 0;
            return (
              <tr key={l.lineId}>
                <td>{l.service}</td>
                <td>
                  <input className="input" style={{ minWidth: 120 }} value={e.supplier} onChange={(ev) => setEdits((x) => ({ ...x, [l.lineId]: { ...e, supplier: ev.target.value } }))} />
                </td>
                <td style={{ textAlign: 'right' }}>{l.qty}</td>
                <td>
                  <input className="input" style={{ width: 100 }} inputMode="decimal" value={e.cost} onChange={(ev) => setEdits((x) => ({ ...x, [l.lineId]: { ...e, cost: ev.target.value } }))} />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <select className="input" style={{ width: 70 }} value={e.type} onChange={(ev) => setEdits((x) => ({ ...x, [l.lineId]: { ...e, type: ev.target.value as 'percent' | 'amount' } }))}>
                      <option value="percent">%</option>
                      <option value="amount">Ksh</option>
                    </select>
                    <input className="input" style={{ width: 70 }} inputMode="decimal" value={e.value} onChange={(ev) => setEdits((x) => ({ ...x, [l.lineId]: { ...e, value: ev.target.value } }))} />
                  </div>
                  {suggested > 0 && suggested !== l.unitPrice && <div className="note">gives {fmtKsh(suggested)} — sold at {fmtKsh(l.unitPrice)}</div>}
                </td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(l.unitPrice)}</td>
                <td style={{ textAlign: 'right' }}>{Number(e.cost) > 0 ? fmtKsh(Number(e.cost) * l.qty) : <Tag tone="bad">not costed</Tag>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="btn btn-secondary btn-sm" onClick={saveQuotes} disabled={busy}>
        Save supplier quote
      </button>
      <span className="note"> Saving the quote records the cost and mark-up; it does not change what the customer is charged.</span>

      <div className="card-kicker" style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>
        Supplier bills &amp; payments
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Supplier</th>
            <th>Invoice</th>
            <th style={{ textAlign: 'right' }}>Bill</th>
            <th style={{ textAlign: 'right' }}>Paid</th>
            <th style={{ textAlign: 'right' }}>Owing</th>
          </tr>
        </thead>
        <tbody>
          {data.bills.length === 0 && (
            <tr>
              <td colSpan={6} className="text-muted">
                No supplier bill recorded yet.
              </td>
            </tr>
          )}
          {data.bills.map((b) => (
            <tr key={b.id}>
              <td className="text-muted">{fmtDate(b.date)}</td>
              <td>{b.supplier}</td>
              <td className="text-muted">{b.invoiceNumber || '—'}</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(b.amount)}</td>
              <td style={{ textAlign: 'right' }}>{fmtKsh(b.paid)}</td>
              <td style={{ textAlign: 'right', fontWeight: b.owing > 0 ? 700 : undefined }}>{b.owing > 0 ? fmtKsh(b.owing) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr auto', gap: 'var(--space-2)', alignItems: 'end', marginTop: 'var(--space-2)' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Supplier</label>
          <input className="input" value={bill.supplierName} onChange={(e) => setBill((b) => ({ ...b, supplierName: e.target.value }))} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Bill total (VAT incl.)</label>
          <input className="input" inputMode="decimal" value={bill.amount} onChange={(e) => setBill((b) => ({ ...b, amount: e.target.value }))} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Paid now (deposit or full)</label>
          <input className="input" inputMode="decimal" value={bill.paidNow} onChange={(e) => setBill((b) => ({ ...b, paidNow: e.target.value }))} placeholder="0" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Paid by</label>
          <select className="input" value={bill.method} onChange={(e) => setBill((b) => ({ ...b, method: e.target.value }))}>
            {EXPENSE_METHODS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Invoice / receipt #</label>
          <input className="input" value={bill.invoiceNumber} onChange={(e) => setBill((b) => ({ ...b, invoiceNumber: e.target.value }))} />
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={recordBill} disabled={busy || !bill.supplierName.trim() || !(Number(bill.amount) > 0)}>
          Record bill
        </button>
      </div>
      <p className="note">A deposit is paid now; whatever is left stays owing to the supplier (Accounting → Payables) and is paid later from Finance → Expenses. The whole bill counts as the job's cost of sales.</p>

      <div className="card-kicker" style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>
        Profit on this job
      </div>
      <table className="table">
        <tbody>
          <tr>
            <td>Customer pays (VAT incl.)</td>
            <td style={{ textAlign: 'right' }}>{fmtKsh(m.sale)}</td>
          </tr>
          <tr>
            <td>
              Supplier cost (VAT incl.) <span className="text-muted">— from {data.costBasis}</span>
            </td>
            <td style={{ textAlign: 'right' }}>{fmtKsh(m.cost)}</td>
          </tr>
          <tr style={{ fontWeight: 700 }}>
            <td>Difference</td>
            <td style={{ textAlign: 'right' }}>
              {fmtKsh(m.grossProfit)} <span className="text-muted">({m.markupPct ?? '—'}% mark-up · {m.marginPct ?? '—'}% margin)</span>
            </td>
          </tr>
          <tr>
            <td>
              Profit in the books <span className="text-muted">— the sale without its 16% VAT, less the supplier's bill without its VAT (their VAT is claimed back as input VAT)</span>
            </td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              {fmtKsh(m.bookProfit)} <span className="text-muted">({m.bookMarginPct ?? '—'}%)</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
