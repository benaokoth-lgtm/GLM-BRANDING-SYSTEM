import { Link } from 'react-router-dom';
import { useBranding } from '../hooks/useBranding';

// A public page (no sign-in): how a person asks for their data to be deleted. Its address is what Meta asks for as the app's "Data deletion instructions URL"
// when WhatsApp Business is connected. Edit the wording here if the practice changes.

export default function DataDeletion() {
  const branding = useBranding();
  const company = branding?.companyName || 'GLM Branding';
  const h2 = { marginTop: 'var(--space-5)', marginBottom: 'var(--space-2)' } as const;

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: 'var(--space-5) var(--space-4)', lineHeight: 1.65 }}>
      <p style={{ margin: 0 }}>
        <Link to="/login">← Back to sign-in</Link> · <Link to="/privacy">Privacy policy</Link>
      </p>
      <h1 style={{ marginBottom: 'var(--space-1)' }}>Data deletion instructions</h1>
      <p className="text-muted" style={{ marginTop: 0 }}>
        {company} · Last updated 22 October 2026
      </p>

      <p>
        {company} holds information about its customers (name, phone number, email, the orders, quotations, invoices and payments made with us, and the WhatsApp messages and documents we have sent to them) and about its staff. If you would like that information deleted, this is how to ask.
      </p>

      <h2 style={h2}>How to ask</h2>
      <ol>
        <li>
          Contact {company} by email, phone or WhatsApp, using the details on any of our invoices or receipts or at <a href="https://glmgroup.co.ke">glmgroup.co.ke</a>, and say <b>“Please delete my data”</b>.
        </li>
        <li>Give the name and the phone number (or email) you used with us, so we can find your records. We may ask you to confirm it is you before anything is deleted.</li>
        <li>We will confirm in writing that we have received the request, normally within 7 days, and tell you when it has been done — within 30 days.</li>
      </ol>

      <h2 style={h2}>What is deleted</h2>
      <ul>
        <li>Your contact details (phone number, email, address) and any saved client record.</li>
        <li>The record of WhatsApp and email messages we sent to you, and the files attached to them.</li>
        <li>Anything else we hold that identifies you and that we are not required to keep.</li>
      </ul>

      <h2 style={h2}>What we may have to keep</h2>
      <p>
        Invoices, receipts, payments and similar financial records must be kept for the period the law requires (tax and accounting records are normally kept for several years). Where we must keep a record, we remove or blank the details that identify you as far as the law allows, keep the rest only for that purpose, and delete it when the period ends. We will tell you if this applies to your request.
      </p>

      <h2 style={h2}>Stop messages without deleting anything</h2>
      <p>To stop receiving WhatsApp messages from us, reply <b>STOP</b> to any message or tell us, and we will not message you again.</p>

      <h2 style={h2}>If you are not satisfied</h2>
      <p>You may complain to the Office of the Data Protection Commissioner of Kenya (<a href="https://www.odpc.go.ke">odpc.go.ke</a>).</p>
    </div>
  );
}
