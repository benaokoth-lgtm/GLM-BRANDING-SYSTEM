import { Card, Loading, numStyle, useLoad } from '../pages/accounting/shared';

// "How you are paid" — the employee pay guide, written from the CURRENT settings (Commission → Rates): the pay bands, the performance floor, the minimum wage, the payday,
// the film and artwork rates. Nothing in it is typed in by hand, so when an Admin changes a band it changes here — and on the My commission screen — at once.
// Print / PDF gives the up-to-date copy to hand out.

interface Band {
  from: number;
  payout: number;
}
interface Rate {
  from: number;
  rate: number;
}
interface Guide {
  config: {
    generalMode: 'steps' | 'percent';
    payBands: Band[];
    performanceFloor: number;
    minimumWage: number;
    payday: number;
    filmBands: Rate[];
    artworkRatePct: number;
    ownershipMonths: number;
    /** The month sales persons start being paid as contractors ('' = not switched on) and the standard withholding tax rate. */
    contractorFrom?: string;
    freelanceWhtRate?: number;
  };
  vatRate: number;
  examples: { gross: number; label: string; nssf: number; shif: number; housingLevy: number; paye: number; net: number }[];
  film: { base: number; metres: number; highPrice: number; highEarns: number; lowPrice: number; lowEarns: number };
  artwork: { pieces: number; recommended: number; charged: number; earns: number };
}

const money = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money2 = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
const pctText = (n: number) => `${parseFloat(Number(n).toFixed(2))}%`;

export default function PayGuide() {
  const { data, error, loading } = useLoad<Guide>('/commission/pay-guide');
  if (!data) return <Loading loading={loading} error={error} />;
  const { config: c, examples, film, artwork } = data;
  const bands = [...c.payBands].sort((a, b) => a.from - b.from);
  const steps = c.generalMode === 'steps';
  const top = bands[bands.length - 1]?.payout ?? 0;
  const vatPct = Math.round(data.vatRate * 100);
  const rangeOf = (i: number) => (i === 0 ? `Below ${money(bands[1]?.from ?? 0)}` : bands[i + 1] ? `${money(bands[i]!.from)} – ${money(bands[i + 1]!.from - 1)}` : `${money(bands[i]!.from)} and above`);
  const paidOf = (payout: number) => Math.max(payout, c.minimumWage);
  // the band that starts at the target (or the first at or above it), and the one just under it
  const targetIdx = Math.max(0, bands.findIndex((b) => b.from >= c.performanceFloor));
  const under = bands[targetIdx - 1];
  const target = bands[targetIdx];
  // sales below which the minimum wage is what is paid
  const firstAbove = bands.find((b) => b.payout > c.minimumWage);
  const clientMonths = c.ownershipMonths;
  const payday = ordinal(c.payday);

  return (
    <>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          Print / PDF
        </button>
        <span className="note" style={{ margin: 0 }}>This guide is written from the current settings, so it is always up to date. Print it to give staff a copy.</span>
      </div>

      {c.contractorFrom && (
        <Card title={`Paid as a contractor from ${c.contractorFrom}`}>
          <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            <li>From <b>{c.contractorFrom}</b> your month is <b>one total</b> — the band payout, the film and artwork premium and any commission — with <b>withholding tax ({c.freelanceWhtRate ?? 5}% unless you have your own rate) taken off it</b>. You receive the rest.</li>
            <li>It is paid <b>outside payroll</b>, so there is no PAYE, NSSF or SHIF, by <b>M-Pesa to your phone</b> or by the method agreed with you, once the month is over. You get a tax withheld certificate from the company; keep your <b>KRA PIN</b> and M-Pesa number up to date with the office.</li>
            <li>The minimum wage shown below is paid only if the office has switched it on for you.</li>
          </ul>
        </Card>
      )}

      <Card title="Your pay — the short version">
        <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          {steps ? (
            <>
              <li><b>Your pay for a month is the payout of the band your month's sales reached.</b> There are {bands.length} bands, from the minimum wage up to <b>KES {money(top)}</b> a month.</li>
              <li>It is a <b>step, not a slice</b>: stay in a band and the payout stays the same; reach the next band and it moves up to that band's payout.</li>
              <li><b>You are never paid less than the minimum wage</b> — KES {money2(c.minimumWage)} a month at present.</li>
              <li><b>Sales below KES {money(c.performanceFloor)} in a month require performance improvement.</b> You see a notice on your own screen; the managers who run commission see it too.</li>
            </>
          ) : (
            <li>Your sourced sales are currently paid as a percentage of the month's net sales in bands, after a sales target. See <b>How you earn</b> on the My commission tab for the figures that apply.</li>
          )}
          <li><b>Film and artwork extras are paid on top</b> when you charge above the base or recommended price.</li>
          <li><b>Payday is the {payday} of every month</b>, for the month before. PAYE, NSSF, SHIF and the housing levy come off, and your payslip shows each one.</li>
          <li>Every figure traces to an order and a payment — see <b>My commission</b> for exactly how your month was made up.</li>
        </ul>
      </Card>

      <Card title="How a month works">
        <ol className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          <li><b>You sell</b> all month and customers pay. Only money <i>received</i> in the month counts.</li>
          <li><b>The month ends</b>, which fixes your sales for it.</li>
          <li><b>A manager approves the month</b> (Commission → Team &amp; payouts).</li>
          <li><b>Your pay goes into payroll</b>, with the deductions, and you are paid on the <b>{payday}</b> for the month before — September's pay on the {payday} of October.</li>
        </ol>
        <p className="note">Each month stands on its own: nothing is carried forward or averaged.</p>
      </Card>

      <Card title="What counts as your sales" hint={`Money customers have paid in the month, with VAT (${vatPct}%) taken out.`}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Counts</th>
                <th>Does not count</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ verticalAlign: 'top' }}>
                  Money received <b>in that month</b> on orders from <b>clients credited to you</b>, whoever captured the order.
                  <br />Film and artwork orders <b>you captured</b>.
                  <br />Deposits and part-payments, in the month each arrives.
                </td>
                <td style={{ verticalAlign: 'top' }}>
                  An order raised but <b>not yet paid</b> — it counts in the month the money arrives.
                  <br />House sales (no sales person credited), and orders credited to a freelance sales person.
                  <br />Refunds and credit notes reduce the month they are made in.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note">
          <b>Example:</b> a client you brought in orders printing worth KES 58,000 including VAT = KES 58,000 ÷ {(1 + data.vatRate).toFixed(2)} = <b>KES 50,000</b> of sales. If they pay KES 29,000 on the 28th and the balance in the next month, KES 25,000 counts in each month.
        </p>
        <p className="note">
          <b>Clients credited to you:</b> tick <i>"[your name] brought this client in"</i> when you capture a new client's first order, and the client stays yours for <b>{clientMonths} months</b>. A client belongs to one person; the system tells you if someone else has them. Claim honestly — walk-ins and clients the shop already had are house sales.
        </p>
      </Card>

      {steps && (
        <>
          <Card title="The pay bands" hint="Find the band your month's net sales reached. That band's payout is your pay, and never less than the minimum wage.">
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Monthly sales (net of VAT)</th>
                    <th style={numStyle}>Band payout</th>
                    <th style={numStyle}>You are paid</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((b, i) => (
                    <tr key={b.from} style={i === targetIdx ? { fontWeight: 700, background: 'var(--color-surface-2, transparent)' } : undefined}>
                      <td>{i}</td>
                      <td>
                        {rangeOf(i)}
                        {i === targetIdx && <span className="text-muted"> (the monthly target)</span>}
                      </td>
                      <td style={numStyle}>{money(b.payout)}</td>
                      <td style={numStyle}>
                        {b.payout < c.minimumWage ? (
                          <>
                            {money2(c.minimumWage)} <span className="text-muted">(minimum wage)</span>
                          </>
                        ) : (
                          money(b.payout)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'grid', gap: 6, margin: 'var(--space-3) 0', maxWidth: 640 }}>
              {bands.map((b, i) => {
                const prev = bands[i - 1];
                // bands paying the minimum wage are one bar: show it once, at the first of them
                if (prev && b.payout < c.minimumWage && prev.payout < c.minimumWage) return null;
                const first = b.payout < c.minimumWage;
                const label = first ? `Below ${money(firstAbove?.from ?? b.from)}` : `${money(b.from)}+`;
                return (
                  <div key={b.from} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 80px', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <span className="text-muted">{label}</span>
                    <div style={{ background: 'var(--color-divider)', height: 18 }}>
                      <div style={{ width: `${(paidOf(b.payout) / (top || 1)) * 100}%`, height: '100%', background: i === targetIdx ? 'var(--color-accent)' : first ? 'var(--color-text-muted)' : 'var(--color-text)' }} />
                    </div>
                    <b style={{ textAlign: 'right' }}>{money(paidOf(b.payout))}</b>
                  </div>
                );
              })}
            </div>
            <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
              <li>
                <b>A step, not a slice.</b> The payout is the whole amount for the band, not a percentage.
                {under && target && (
                  <>
                    {' '}
                    At KES {money(c.performanceFloor - 1)} of sales you are paid <b>{money(paidOf(under.payout))}</b>; at KES {money(c.performanceFloor)} you are paid <b>{money(paidOf(target.payout))}</b> — that one shilling moved you up KES {money(paidOf(target.payout) - paidOf(under.payout))}.
                  </>
                )}
              </li>
              <li>A payment collected on the last day of the month can lift you into the next band. The payout you have earned in a band continues to apply until you reach the next one.</li>
              {firstAbove && firstAbove.from > 0 && (
                <li>
                  Because the minimum wage (KES {money2(c.minimumWage)}) is higher than the lower payouts, <b>your pay is the minimum wage until your month's sales reach KES {money(firstAbove.from)}</b>.
                </li>
              )}
            </ul>
          </Card>

          <Card title="The minimum wage guarantee">
            <p className="note" style={{ margin: 0 }}>
              If the band payout for your month is lower than the minimum wage (<b>KES {money2(c.minimumWage)}</b>), the minimum wage is paid as your pay for the month — even in a month with no sales at all. The system adds the difference for you and shows it on the My commission screen as <i>Minimum wage</i>.
            </p>
          </Card>

          <Card title={`The monthly target: KES ${money(c.performanceFloor)}`}>
            <p className="note" style={{ margin: 0 }}>
              <b>Sales below KES {money(c.performanceFloor)} in a month require performance improvement.</b> You see a red notice on your own screen, with how much more reaches the target; once the month has closed below it, the managers who run commission see it marked <b>needs improvement</b>. It is a flag, not a deduction: your pay is set by the bands and the minimum wage. What follows is for your supervisor and management to arrange under your terms of employment.
            </p>
            <p className="note">
              <b>To reach it:</b> bring in new clients and claim them, go back to existing clients for repeat orders, collect deposits and balances before the month ends (only money received counts), and offer embroidery, film and artwork. Prices are never relaxed to help anyone reach a band.
            </p>
          </Card>
        </>
      )}

      <Card title="Film and artwork extras" hint="Paid on top of your pay, as the customer pays (a half-paid order earns half).">
        <p className="note" style={{ marginTop: 0 }}>
          <b>DTF film, by the metre.</b> The base price is the minimum price per metre (KES {money(film.base)}). Everything you charge <b>above</b> it earns a share of the extra, in slices per metre:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ maxWidth: 420 }}>
            <thead>
              <tr>
                <th>Extra above base, per metre</th>
                <th style={numStyle}>Share paid</th>
              </tr>
            </thead>
            <tbody>
              {[...c.filmBands].sort((a, b) => a.from - b.from).map((b, i, all) => (
                <tr key={b.from}>
                  <td>{i === all.length - 1 ? `Over ${money(b.from)}` : `${money(b.from)} – ${money(all[i + 1]!.from)}`}</td>
                  <td style={numStyle}>{pctText(b.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          <b>Example:</b> {film.metres} metres sold at KES {money(film.highPrice)} a metre earns about <b>KES {money(Math.round(film.highEarns))}</b>; the same job at KES {money(film.lowPrice)} a metre earns about <b>KES {money(Math.round(film.lowEarns))}</b>.
        </p>
        <p className="note">
          <b>DTF artwork, per piece.</b> If you charge more than the system's recommended price you earn <b>{pctText(c.artworkRatePct)}</b> of the extra (VAT out), and nothing on the recommended price itself. <b>Example:</b> {artwork.pieces} pieces, recommended KES {artwork.recommended}, charged KES {artwork.charged}: about <b>KES {money(Math.round(artwork.earns))}</b>. Charging less is a discount: no extra is earned and a manager must approve it first.
        </p>
      </Card>

      <Card title="From your pay to what you take home" hint="Statutory deductions come off before you are paid; the company pays its own matching NSSF and housing-levy contributions on top.">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Gross pay</th>
                <th style={numStyle}>NSSF</th>
                <th style={numStyle}>SHIF</th>
                <th style={numStyle}>Housing levy</th>
                <th style={numStyle}>PAYE</th>
                <th style={numStyle}>Take-home</th>
              </tr>
            </thead>
            <tbody>
              {examples.map((e) => (
                <tr key={e.label + e.gross}>
                  <td>
                    {money2(e.gross)} <span className="text-muted">({e.label.toLowerCase()})</span>
                  </td>
                  <td style={numStyle}>{money2(e.nssf)}</td>
                  <td style={numStyle}>{money2(e.shif)}</td>
                  <td style={numStyle}>{money2(e.housingLevy)}</td>
                  <td style={numStyle}>{money2(e.paye)}</td>
                  <td style={{ ...numStyle, fontWeight: 700 }}>{money2(e.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Worked out by the payroll's own rules for pay with no extras or other allowances. Your payslip shows your own figures; the payroll always uses the statutory rates in force at the time. Film and artwork extras are part of your gross and are taxed with it. Ask finance for your P9 at year end.</p>
      </Card>

      <Card title="When and how you are paid">
        <ol className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          <li>The month ends and your sales are fixed.</li>
          <li>A manager approves the month, and your pay goes into payroll automatically — one entry dated the last day of the month.</li>
          <li><b>You are paid on the {payday} of the next month</b> — your September pay on the {payday} of October, and so on. Your payslip lists the gross pay and every deduction.</li>
        </ol>
      </Card>

      <Card title="Rules of the road">
        <ul className="note" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          <li><b>Prices are protected.</b> Minimum prices at order taking are never relaxed to reach a band; a discount above the ceiling needs supervisor approval; a lower artwork or embroidery price needs a manager's approval first.</li>
          <li><b>No double credit.</b> A client or order is credited to one person — a staff member or a freelance sales person, never both.</li>
          <li><b>Claim honestly</b>, and record every payment through the order screen — only recorded payments count.</li>
          <li><b>If a figure looks wrong,</b> talk to your supervisor or finance straight away. Every figure traces to an order and a payment, so questions are quick to settle.</li>
        </ul>
        <p className="note">Only an Admin can change the bands, the target, the minimum wage or the payday. This page always shows what is in force now.</p>
      </Card>
    </>
  );
}

