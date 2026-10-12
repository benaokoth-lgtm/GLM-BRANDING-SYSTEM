import { useEffect, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';

// The gross margin on an Outsourced Order, shown on the opened order to the sales person it is for and to people who can see costs: the sale and the cost with and without VAT,
// the gross profit and margin, and what the job earns in commission. The figures are the server's, so they agree with the commission statement.

interface Margin {
  saleIncl: number;
  netSales: number;
  outputVat: number;
  costIncl: number;
  netCost: number;
  inputVatClaimed: number;
  vatInCost: number;
  grossProfit: number;
  marginPct: number | null;
  quoted: number;
  billed: number;
  lines: { name: string; qty: number; unitPrice: number; unitCost: number; supplierName: string | null; vatClaimable: boolean; grossProfit: number; marginPct: number | null }[];
  commission: { enabled: boolean; ratePct: number; fullAmount: number; earnedSoFar: number; paidShare: number };
}

export default function OutsourcedMarginCard({ orderId }: { orderId: number }) {
  const [m, setM] = useState<Margin | null>(null);
  useEffect(() => {
    api.get<Margin>(`/orders/${orderId}/margin`).then(setM).catch(() => setM(null)); // not for everyone: a 403 simply shows nothing
  }, [orderId]);
  if (!m) return null;
  const pct = (n: number | null) => (n == null ? '—' : `${parseFloat(n.toFixed(1))}%`);
  const overrun = m.billed > m.quoted + 0.005;
  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', margin: 'var(--space-3) 0' }}>
      <div className="card-kicker">Gross margin on this job</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Selling / unit</th>
              <th style={{ textAlign: 'right' }}>Purchasing / unit</th>
              <th style={{ textAlign: 'right' }}>Gross profit</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {m.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.name}
                  {l.supplierName && <span className="text-muted"> · {l.supplierName}</span>}
                  <span className="text-muted"> · {l.vatClaimable ? 'VAT claimable' : 'VAT not claimable'}</span>
                </td>
                <td style={{ textAlign: 'right' }}>{l.qty}</td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(l.unitPrice)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(l.unitCost)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKsh(l.grossProfit)}</td>
                <td style={{ textAlign: 'right' }}>{pct(l.marginPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ margin: 'var(--space-1) 0' }}>
        Net sales <b>{fmtKsh(m.netSales)}</b> (after {fmtKsh(m.outputVat)} output VAT) − net cost <b>{fmtKsh(m.netCost)}</b>
        {m.inputVatClaimed > 0 ? ` (after ${fmtKsh(m.inputVatClaimed)} input VAT claimed back)` : ''}
        {m.vatInCost > 0 ? ` (includes ${fmtKsh(m.vatInCost)} VAT that cannot be claimed)` : ''} = <b>gross profit {fmtKsh(m.grossProfit)}</b> · margin <b>{pct(m.marginPct)}</b>.
      </p>
      {overrun && (
        <p className="note" style={{ margin: 'var(--space-1) 0', color: 'var(--color-error)' }}>
          The supplier has billed {fmtKsh(m.billed)} against a quote of {fmtKsh(m.quoted)}; the cost above uses the bill.
        </p>
      )}
      {m.commission.enabled && (
        <p className="note" style={{ margin: 'var(--space-1) 0 0' }}>
          Commission on this job: {m.commission.ratePct}% of the gross profit = <b>{fmtKsh(m.commission.fullAmount)}</b>; earned so far, as the customer has paid {Math.round(m.commission.paidShare * 100)}%: <b>{fmtKsh(m.commission.earnedSoFar)}</b>.
        </p>
      )}
    </div>
  );
}
