import { bandedAmount, fmtKsh, fmtNum } from '@glm/shared';
import type { Band } from '@glm/shared';
import { Card, Loading, useLoad } from '../pages/accounting/shared';

// Commission → Freelancers → How it works: how a freelance sales person is credited, what counts, how the weekly commission is worked out, and how it is paid. Written from the CURRENT settings
// (Commission → Rates), including worked examples, so it never goes out of date: when an Admin changes a band or a percentage, it changes here at once.

interface Settings {
  freelanceBands: Band[];
  freelanceOwnershipMonths: number;
  freelanceWhtRate: number;
  freelancePremiumPct: number;
  freelanceLowMarginPct: number;
}

const VAT = 1.16;
const pct = (n: number) => `${parseFloat(Number(n).toFixed(2))}%`;

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '34px 1fr', gap: 'var(--space-3)', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--color-divider)' }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--color-accent)', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{n}</div>
      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{title}</div>
        <div style={{ display: 'grid', gap: 6 }}>{children}</div>
      </div>
    </div>
  );
}

export default function FreelanceGuide() {
  const { data, error, loading } = useLoad<Settings>('/commission/settings');
  if (!data) return <Loading loading={loading} error={error} />;
  const bands = [...data.freelanceBands].sort((a, b) => a.from - b.from);
  const premiumPct = data.freelancePremiumPct;
  const lowPct = data.freelanceLowMarginPct;
  const wht = data.freelanceWhtRate;
  const months = data.freelanceOwnershipMonths;
  const rangeOf = (i: number) => (bands[i + 1] ? `${fmtNum(bands[i]!.from)} – ${fmtNum(bands[i + 1]!.from)}` : `above ${fmtNum(bands[i]!.from)}`);

  // Worked examples, all from the settings
  const tax = (commission: number) => Math.round(commission * (wht / 100) * 100) / 100;
  const ex1Net = 50000;
  const ex1Base = bandedAmount(bands, ex1Net);
  const ex2Base = ex1Net;
  const ex2PremiumNet = 10000;
  const ex2BaseCommission = bandedAmount(bands, ex2Base);
  const ex2Premium = (ex2PremiumNet * premiumPct) / 100;
  const ex2Total = ex2BaseCommission + ex2Premium;
  const lowNet = 10000;
  const lowCounts = (lowNet * lowPct) / 100;

  return (
    <Card title="How freelance sales persons are paid" hint="Written from the current rates (Commission → Rates): when a rate changes, this changes with it.">
      <div style={{ display: 'grid' }}>
        <Step n={1} title="Who is a freelance sales person, and how an order becomes theirs">
          <p style={{ margin: 0 }}>A freelance sales person is someone <b>outside the staff</b> who brings us work. When an order is taken, whoever captures it marks it as <b>brought by a freelance sales person</b> and picks them (or adds them: a new person waits for a manager’s approval under <b>Freelance sales persons &amp; accounts</b> before anything is paid to them).</p>
          <p style={{ margin: 0 }}>An order marked for a freelancer is <b>credited to them alone</b>: no staff member earns commission on it and it counts towards no staff sales target. A freelancer cannot be given a client who already belongs to a staff member, and a staff member cannot take a client who belongs to a freelancer.</p>
          <p style={{ margin: 0 }}><b>Their clients stay theirs.</b> A named client with a phone number (or a corporate account) becomes the freelancer’s client the first time they bring them. While an order from that client comes at least every <b>{months} months</b>, every order from them is the freelancer’s, <b>whoever captures it</b>: each order restarts the count. A manager can release a client early under Freelance sales persons &amp; accounts.</p>
        </Step>

        <Step n={2} title="When commission is earned: as the customer pays, by the week">
          <p style={{ margin: 0 }}>Commission is worked out on <b>money received</b>, not on what was invoiced. The week runs <b>Monday to Sunday</b>; a payment counts in the week it was received, and a part-payment earns commission on the part paid (an order paid in two weeks earns in both). Credit notes and refunds in the week are taken off.</p>
          <p style={{ margin: 0 }}>Everything is counted <b>net of VAT</b> (output VAT is not ours, and a freelancer is paid on sales, not on profit). Weekly figures are read in <b>Commission → Freelancers → Weekly pay</b>.</p>
        </Step>

        <Step n={3} title="What counts: only what is sold at or above the base price">
          <p style={{ margin: 0 }}>The <b>base price</b> is the price we must have to make our minimum margin: the list price of a service or material, the <b>minimum price</b> of DTF film, or the <b>recommended price</b> of an artwork job (the heat press fee is part of it). It is checked <b>when the order is taken</b>, after the line’s own discount and its share of any discount on the whole order.</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>A line sold <b>at or above</b> its base price counts. Its price splits into the <b>base part</b> (up to base) and the <b>premium</b> (whatever was charged above it).</li>
            <li>A line sold <b>below</b> its base price is <b>left out whole</b>: it earns the freelancer nothing, not even on the part that reached base. The week’s statement shows it as “below base”.</li>
          </ul>
        </Step>

        <Step n={4} title="The commission has two parts">
          <p style={{ margin: 0 }}><b>A. The base part, in bands</b> — a small percentage of the week’s base-price sales, in marginal bands: each rate applies <b>only to the slice of the week</b> inside its band.</p>
          <table className="table" style={{ maxWidth: 520 }}>
            <thead>
              <tr>
                <th>The week’s base-price sales (net)</th>
                <th style={{ textAlign: 'right' }}>Rate on that slice</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={b.from}>
                  <td>{rangeOf(i)}</td>
                  <td style={{ textAlign: 'right' }}>{pct(b.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: 0 }}>Contracted-out services and stock resale carry only a thin mark-up, so their base part counts towards the bands at <b>{pct(lowPct)}</b> (the amount above their base is still shared in full).</p>
          <p style={{ margin: 0 }}><b>B. The premium, as a share</b> — the freelancer keeps <b>{pct(premiumPct)}</b> of everything charged <b>above</b> base (net of VAT). It costs us nothing extra to sell the same job for more, so it is nearly all profit; the company keeps the rest.</p>
          <p style={{ margin: 0 }}><b>Commission = A + B.</b> Withholding tax is then deducted from it (below).</p>
        </Step>

        <Step n={5} title="Worked examples, at today’s rates">
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 4 }}>
            <b>Everything sold at base prices.</b>
            <span>
              The freelancer’s orders are paid {fmtKsh(ex1Net * VAT)} in the week (VAT included), which is <b>{fmtKsh(ex1Net)}</b> net, all base part. The bands pay <b>{fmtKsh(ex1Base)}</b>. After {pct(wht)} withholding tax ({fmtKsh(tax(ex1Base))}) they receive <b>{fmtKsh(ex1Base - tax(ex1Base))}</b>.
            </span>
          </div>
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 4 }}>
            <b>Some of it sold above base.</b>
            <span>
              Paid {fmtKsh((ex2Base + ex2PremiumNet) * VAT)} in the week: {fmtKsh(ex2Base)} net is the base part and {fmtKsh(ex2PremiumNet)} net was charged above base. Part A pays {fmtKsh(ex2BaseCommission)}; part B pays {pct(premiumPct)} of {fmtKsh(ex2PremiumNet)} = {fmtKsh(ex2Premium)}. Commission <b>{fmtKsh(ex2Total)}</b>; after {pct(wht)} tax ({fmtKsh(tax(ex2Total))}) they receive <b>{fmtKsh(ex2Total - tax(ex2Total))}</b>.
            </span>
          </div>
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 4 }}>
            <b>A line sold below base, and a thin-margin line.</b>
            <span>
              A job whose list price is {fmtKsh(5800)} but was sold for {fmtKsh(5000)} earns <b>nothing</b>, and its {fmtKsh(5000 / VAT)} net does not count towards the bands either. A contracted-out line with {fmtKsh(lowNet)} net of base part counts as only {fmtKsh(lowCounts)} towards the bands ({pct(lowPct)}).
            </span>
          </div>
        </Step>

        <Step n={6} title="Tax withheld">
          <p style={{ margin: 0 }}>Withholding tax is deducted from the commission at <b>{pct(wht)}</b> (the standard rate; a person can have their own rate, and <b>0</b> if they hold an exemption certificate). The freelancer is paid the commission <b>less</b> the tax; the tax is ours to pay to KRA. The month’s figures for the withholding return are under <b>Freelance sales persons &amp; accounts → Tax withheld</b>, with each person’s year statement. Keep each freelancer’s <b>KRA PIN and national ID</b> on file.</p>
        </Step>

        <Step n={7} title="Approving and paying the week">
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>Once the week is over, a manager presses <b>Approve week</b> under <b>Weekly pay</b>. Only people who are <b>Active</b> are approved: a new person waiting for approval, or a suspended one, is listed as skipped, with the reason.</li>
            <li>Each approved person is then <b>paid</b>: by cash, cheque, bank transfer or M-Pesa recorded by hand, or <b>sent straight to their M-Pesa phone</b> from the screen when that is set up (Safaricom confirms the result; a failed or timed-out attempt leaves the payout ready to try again).</li>
            <li><b>Paying books the cost</b> as a <b>Freelance Commission</b> expense, so it reaches the profit and loss (and the petty cash float, when paid from it). Paid commission lowers the profit the company’s income tax is worked out on.</li>
            <li>An approved week can be taken back before it is paid (so it can be recalculated and approved again, if a payment or credit note arrives late); a paid one cannot.</li>
          </ol>
        </Step>

        <Step n={8} title="What freelancers and staff see">
          <p style={{ margin: 0 }}>Freelancers are not system users: they see nothing. Their <b>account</b> (<i>Freelance sales persons &amp; accounts</i>) lists every week, what was earned, what was paid and what is still owed, to give them. Staff never see a freelancer’s earnings, and a freelancer’s orders do not appear in any staff member’s commission.</p>
        </Step>
      </div>
    </Card>
  );
}
