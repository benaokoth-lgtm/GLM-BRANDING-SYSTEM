import { fmtKsh, freelanceCommission, withholdingOn } from '@glm/shared';
import { Card, Loading, useLoad } from '../pages/accounting/shared';

// Commission → Freelancers → How it works: how a freelance sales person is credited, what counts, how the weekly commission is worked out, and how it is paid. Written from the CURRENT settings
// (Commission → Freelancers → Rates), including a worked example, so it never goes out of date: when an Admin changes a rate, it changes here at once.

interface Settings {
  freelanceRatePct: number;
  freelanceLowRatePct: number;
  freelanceOwnershipMonths: number;
  freelanceWhtRate: number;
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
  const rate = data.freelanceRatePct;
  const lowRate = data.freelanceLowRatePct;
  const wht = data.freelanceWhtRate;
  const months = data.freelanceOwnershipMonths;

  // Worked examples, all from the settings
  const net = 100_000;
  const c1 = freelanceCommission(net, 0, rate, lowRate).total;
  const lowPart = 20_000;
  const c2 = freelanceCommission(net - lowPart, lowPart, rate, lowRate);

  return (
    <Card title="How freelance sales persons are paid" hint="Written from the current rates (Commission → Freelancers → Rates): when a rate changes, this changes with it.">
      <div style={{ display: 'grid' }}>
        <Step n={1} title="Who is a freelance sales person, and how an order becomes theirs">
          <p style={{ margin: 0 }}>A freelance sales person is someone <b>outside the staff</b> who brings us work. When an order is taken, whoever captures it marks it as <b>brought by a freelance sales person</b> and picks them. The order is then <b>credited to them alone</b>: no staff member earns commission on it and it counts towards no staff sales target.</p>
          <p style={{ margin: 0 }}><b>Their clients stay theirs.</b> A named client with a phone number (or a corporate account) becomes the freelancer’s client the first time they bring them. While an order from that client comes at least every <b>{months} months</b>, the client stays theirs; every order restarts the count.</p>
        </Step>

        <Step n={2} title="When commission is earned: as the customer pays, by the week">
          <p style={{ margin: 0 }}>Commission is worked out on <b>money received</b>, not on what was invoiced. The week runs <b>Monday to Sunday</b>; a payment counts in the week it was received, and a part-payment earns commission on the part paid. A refund or credit note takes its share back in the week it is made.</p>
          <p style={{ margin: 0 }}>Everything is counted <b>net of VAT</b>: the 16% VAT belongs to KRA and is never part of the sale the commission is paid on.</p>
        </Step>

        <Step n={3} title="The commission: one flat percentage">
          <p style={{ margin: 0 }}>The freelancer earns <b>{pct(rate)}</b> of the net sales received. The part of an order that is <b>contracted-out work or stock resale</b> carries only a thin mark-up, so that part earns the lower rate of <b>{pct(lowRate)}</b>. There are no bands and no premium: a discount simply lowers what the client pays, and so what is earned.</p>
        </Step>

        <Step n={4} title="Worked examples, at today’s rates">
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 4 }}>
            <b>A normal week.</b>
            <span>
              The freelancer’s clients pay {fmtKsh(net * VAT)} in the week (VAT included), which is <b>{fmtKsh(net)}</b> net. At {pct(rate)} the commission is <b>{fmtKsh(c1)}</b>. After {pct(wht)} withholding tax ({fmtKsh(withholdingOn(c1, wht))}) they are paid <b>{fmtKsh(c1 - withholdingOn(c1, wht))}</b>.
            </span>
          </div>
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 4 }}>
            <b>Some of it contracted-out work.</b>
            <span>
              Of the same {fmtKsh(net)} net, {fmtKsh(lowPart)} is contracted-out work. That part earns {pct(lowRate)} ({fmtKsh(c2.low)}) and the other {fmtKsh(net - lowPart)} earns {pct(rate)} ({fmtKsh(c2.standard)}): <b>{fmtKsh(c2.total)}</b> in all.
            </span>
          </div>
        </Step>

        <Step n={5} title="Tax withheld">
          <p style={{ margin: 0 }}>Withholding tax is deducted from the commission at <b>{pct(wht)}</b> (the standard rate; a person can have their own rate, and <b>0</b> if they hold an exemption certificate) and paid over to KRA. The freelancer is paid the commission less that tax.</p>
        </Step>

        <Step n={6} title="Approving and paying the week">
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>Once the week is over, a manager presses <b>Approve week</b> under <b>Weekly pay</b>. Only people who are <b>Active</b> are approved; a new or suspended person is listed as skipped, with the reason. The week is approved at the rates in force that day, and an approved week keeps its amount.</li>
            <li>Each approved person is then <b>paid</b>: by cash, cheque, bank transfer or M-Pesa recorded by hand, or <b>sent straight to their M-Pesa phone</b> from the screen when that is set up.</li>
            <li><b>Paying books the cost</b> as a <b>Freelance Commission</b> expense, so it reaches the profit and loss.</li>
            <li>An approved week can be taken back before it is paid (so it can be recalculated and approved again, if a payment or credit note arrives late); a paid one cannot.</li>
          </ol>
        </Step>

        <Step n={7} title="Changing the rates">
          <p style={{ margin: 0 }}>An Admin changes the rates under <b>Rates</b> whenever needed. A new rate applies to every week not yet approved, from the moment it is saved; approved and paid weeks never change. Every change is recorded in the audit trail.</p>
        </Step>
      </div>
    </Card>
  );
}
