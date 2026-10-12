import { useState } from 'react';
import { bandedAmount, fmtKsh, fmtNum, withholdingOn } from '@glm/shared';
import type { Band } from '@glm/shared';

// "What does one big sale pay?" — a worked scenario under the freelancer scale (Commission → Rates): a sale of any size (KES 10 million to start), the commission the scale gives on it, the tax
// withheld from that commission, and what is left for the company after the commission and the income tax on its profit. It reads the scale as it is being edited, so a change shows at once.
// The profit figures rest on one assumption, the gross margin on base-price sales, which the Admin sets from the P&L.

const VAT = 0.16;
const num = (s: string) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export default function BigSaleScenario({ bands, whtRate }: { bands: Band[]; whtRate: number }) {
  const [sale, setSale] = useState('10000000');
  const [margin, setMargin] = useState('35');
  const [taxRate, setTaxRate] = useState('30');

  const incl = Math.max(0, num(sale));
  const net = incl / (1 + VAT);
  const commission = bandedAmount(bands, net);
  const withheld = withholdingOn(commission, whtRate);
  const profitBefore = (net * Math.max(0, Math.min(100, num(margin)))) / 100;
  const profitAfterCommission = profitBefore - commission;
  const tax = Math.max(0, profitAfterCommission) * (Math.max(0, Math.min(100, num(taxRate))) / 100);
  const afterTax = profitAfterCommission - tax;
  const pct = (v: number, of: number) => (of > 0 ? `${fmtNum((v / of) * 100, 2)}%` : '—');
  const row = (label: string, value: string, strong = false, muted = false) => (
    <tr style={strong ? { fontWeight: 700 } : undefined}>
      <td className={muted ? 'text-muted' : undefined}>{label}</td>
      <td style={{ textAlign: 'right' }}>{value}</td>
    </tr>
  );

  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
      <div className="card-kicker">Try the scale on one big sale</div>
      <p className="note" style={{ marginTop: 0 }}>
        What a single sale of any size pays a freelance sales person under the scale above, the tax withheld from them, and what is left for the company. Commission is a business expense, so the income tax is worked out on the profit <b>after</b> it.
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>The sale, VAT included (Ksh)</label>
          <input className="input" style={{ maxWidth: 180 }} inputMode="decimal" value={sale} onChange={(e) => setSale(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Your gross margin on it (%)</label>
          <input className="input" style={{ maxWidth: 110 }} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Income tax on profit (%)</label>
          <input className="input" style={{ maxWidth: 110 }} inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
        </div>
      </div>
      <table className="table" style={{ maxWidth: 560, margin: 'var(--space-2) 0' }}>
        <tbody>
          {row('The customer pays (VAT included)', fmtKsh(incl))}
          {row('less output VAT — owed to KRA', `(${fmtKsh(incl - net)})`, false, true)}
          {row('Net sales', fmtKsh(net), true)}
          {row(`Commission under the scale (${pct(commission, net)} of net sales)`, fmtKsh(commission), true)}
          {row(`less tax withheld from them at ${whtRate}%`, `(${fmtKsh(withheld)})`, false, true)}
          {row('Paid to the freelancer', fmtKsh(commission - withheld), true)}
          {row(`Company gross profit at ${num(margin)}% margin`, fmtKsh(profitBefore))}
          {row('less the commission', `(${fmtKsh(commission)})`, false, true)}
          {row('Profit before income tax', fmtKsh(profitAfterCommission))}
          {row(`less income tax at ${num(taxRate)}% — set this aside`, `(${fmtKsh(tax)})`, false, true)}
          {row('Left for the company', fmtKsh(afterTax), true)}
        </tbody>
      </table>
      <p className="note" style={{ margin: 0 }}>
        The commission takes {pct(commission, profitBefore)} of the gross profit. The margin is your own figure — take it from the P&amp;L — so it is only as good as that. The tax withheld is passed to KRA by the company; the freelancer claims it as a credit on their own return.
      </p>
    </div>
  );
}
