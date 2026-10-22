import { Link } from 'react-router-dom';
import { useBranding } from '../hooks/useBranding';

// A public page (no sign-in) describing what the system stores and why. Its address is what Google asks for as the app's privacy policy
// when Google Drive backups are connected, so it speaks about Google Drive plainly. Edit the wording here if the practice changes.

export default function Privacy() {
  const branding = useBranding();
  const company = branding?.companyName || 'GLM Branding';
  const h2 = { marginTop: 'var(--space-5)', marginBottom: 'var(--space-2)' } as const;

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: 'var(--space-5) var(--space-4)', lineHeight: 1.65 }}>
      <p style={{ margin: 0 }}>
        <Link to="/login">← Back to sign-in</Link>
      </p>
      <h1 style={{ marginBottom: 'var(--space-1)' }}>Privacy Policy</h1>
      <p className="text-muted" style={{ marginTop: 0 }}>
        {company} · Last updated 22 October 2026
      </p>

      <p>
        This is the private business system ({company} POS &amp; Accounting) used by {company} and its staff to take orders, issue invoices and receipts, track production and stock, and keep the company's books. It is not a public service: only people the company has
        added as users can sign in. This policy explains what information the system holds, why, and who can see it.
      </p>

      <h2 style={h2}>Information the system holds</h2>
      <ul>
        <li>
          <b>Staff:</b> names, role, a hashed sign-in PIN (never the PIN itself), and, where the company runs payroll, employee details such as national ID, KRA PIN, SHIF number and pay records.
        </li>
        <li>
          <b>Customers and suppliers:</b> names, phone numbers, email addresses and business details given when an order, quotation or purchase is recorded.
        </li>
        <li>
          <b>Business records:</b> orders, invoices, quotations, payments (including M-Pesa payment references), stock, expenses and accounting entries.
        </li>
      </ul>

      <h2 style={h2}>Why it is used</h2>
      <p>Only to run the business: to serve customers, produce documents, pay staff, meet tax and statutory obligations, and keep accurate records. The information is not sold, rented or used for advertising.</p>

      <h2 style={h2}>Who it is shared with</h2>
      <p>Only as needed to do the job, and only through services the company chooses to switch on:</p>
      <ul>
        <li>an email service, to send invoices, quotations and sign-in details to the person concerned;</li>
        <li>Safaricom M-Pesa, and NCBA Bank where its Paybill is used, to request and confirm customer payments;</li>
        <li>WhatsApp (Meta Platforms), to send a customer their invoice, quotation, receipt or another document, and a summary to the business's own staff, when the company has connected it;</li>
        <li>the company's tax and statutory authorities, where the law requires it;</li>
        <li>Google Drive, to hold backup copies (below).</li>
      </ul>

      <h2 style={h2}>Service providers who handle the information for us</h2>
      <p>
        {company} is responsible for the information in this system. To run it, the company uses service providers who handle information on its behalf and only on its instructions. They are not allowed to use it for their own purposes:
      </p>
      <ul>
        <li>
          <b>The hosting company that runs the secured server</b> (Contabo GmbH) on which the system and its database are kept. It provides the machine; the information on it is protected as described below.
        </li>
        <li>
          <b>Google</b>, only where an administrator has connected Google Drive for backup copies (see below).
        </li>
        <li>
          <b>Meta Platforms (WhatsApp)</b>, only where the company has connected WhatsApp to send documents. The system keeps from Meta only what it needs to send and to show whether a message was sent: its access token (stored sealed), message identifiers and the sent or failed status. It does not receive customers' WhatsApp profiles or contacts from Meta.
        </li>
        <li>
          <b>The email service</b> the company has set up, and <b>Safaricom (M-Pesa) and NCBA Bank</b> for payments, as listed above.
        </li>
      </ul>

      <h2 style={h2}>Requests from public authorities</h2>
      <p>
        {company} does not give personal information to the police, a court, a regulator or any other public authority unless the law requires it. Every such request is handled under a written procedure: the person asking is checked; the legality of the request is reviewed
        before anything is disclosed; a request that is unlawful, unclear or too wide is challenged; only the minimum information needed is disclosed; and each request, the reasoning and what was done are recorded. In the past 12 months {company} has not provided anyone's
        personal information to a public authority in response to a national-security request.
      </p>

      <h2 style={h2}>Google Drive backups</h2>
      <p>
        An administrator can connect the company's Google account so the system can store backup copies of its own data in Google Drive. When this is connected, the system asks Google for one permission only —
        <code> https://www.googleapis.com/auth/drive.file</code> — which lets it create and manage <b>only the files and folder it creates itself</b> (a folder named “GLM POS Backups”). It cannot see, read or change any other file in the Drive.
      </p>
      <p>
        Backup files are used only to restore the company's own system. They are not read by any person at Google or elsewhere through this system, are not shared with anyone, and are not used for advertising or any other purpose. Older backups are deleted automatically
        according to the schedule the administrator sets, and the connection can be removed at any time from within the system or from the Google account's security settings; removing it stops all further copying.
      </p>
      <p>
        {company}'s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2 style={h2}>Where it is kept and how it is protected</h2>
      <p>
        The information is stored in the company's own database on a secured server and is reached only over an encrypted (HTTPS) connection. Each user signs in with a personal PIN, access is limited by role, and failed sign-ins are rate-limited. Backups contain the same information and are
        kept private.
      </p>

      <h2 style={h2}>How long it is kept</h2>
      <p>Business and tax records are kept for as long as the company needs them for its operations and as the law requires. Backup copies are replaced on a rolling schedule.</p>

      <h2 style={h2}>Your rights</h2>
      <p>
        Under Kenya's Data Protection Act, 2019, you may ask {company} what information it holds about you, ask for it to be corrected, or ask for it to be deleted where the law allows. To do so, contact {company} using the details on the company's invoices or at{' '}
        <a href="https://glmgroup.co.ke">glmgroup.co.ke</a>. The steps for asking for deletion are on the <Link to="/data-deletion">data deletion instructions</Link> page.
      </p>

      <h2 style={h2}>Changes</h2>
      <p>If this policy changes, the new version will be published on this page with a new “last updated” date.</p>
    </div>
  );
}
