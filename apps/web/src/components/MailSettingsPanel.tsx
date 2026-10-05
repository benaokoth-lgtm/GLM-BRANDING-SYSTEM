import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useBranding } from '../hooks/useBranding';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → Email: the mail account the system sends from — login PINs to staff, the Admin's PIN-reset code, invoices.
// Edited in a dialog laid out like the "mail client settings" cPanel shows for a mailbox (username, password, incoming server with
// its IMAP / POP3 ports, outgoing server with its SMTP port). The password is never shown again once saved.

interface Mail {
  source: 'settings' | 'env' | 'none';
  configured: boolean;
  username: string;
  outgoingHost: string;
  smtpPort: number;
  incomingHost: string;
  imapPort: number;
  pop3Port: number;
  fromName: string;
  loginUrl: string;
  hasPassword: boolean;
}

const blank = { username: '', password: '', outgoingHost: '', smtpPort: '465', incomingHost: '', imapPort: '993', pop3Port: '995', fromName: '', loginUrl: '' };

export default function MailSettingsPanel() {
  const { data, error, loading, reload } = useLoad<Mail>('/master-data/mail');
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');

  if (!data) return <Loading loading={loading} error={error} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 820 }}>
      <Notice error={error} message={msg} />
      <Card
        title="Email"
        hint="The mail account this system sends from: staff login PINs, the Admin's PIN-reset code, and invoices or quotations emailed to clients."
        actions={<Tag tone={data.configured ? 'good' : 'neutral'}>{data.configured ? 'Set up' : 'Not set up'}</Tag>}
      >
        {data.configured ? (
          <table className="table">
            <tbody>
              <tr>
                <td className="text-muted" style={{ width: 170 }}>
                  Username
                </td>
                <td>{data.username}</td>
              </tr>
              <tr>
                <td className="text-muted">Outgoing server</td>
                <td>
                  {data.outgoingHost} <span className="text-muted">· SMTP port {data.smtpPort}</span>
                </td>
              </tr>
              {data.incomingHost && (
                <tr>
                  <td className="text-muted">Incoming server</td>
                  <td>
                    {data.incomingHost} <span className="text-muted">· IMAP {data.imapPort} · POP3 {data.pop3Port}</span>
                  </td>
                </tr>
              )}
              {data.fromName && (
                <tr>
                  <td className="text-muted">Sent as</td>
                  <td>
                    {data.fromName} &lt;{data.username}&gt;
                  </td>
                </tr>
              )}
              {data.loginUrl && (
                <tr>
                  <td className="text-muted">Sign-in address in emails</td>
                  <td>{data.loginUrl}</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="note">No mail account yet. Open your mailbox's “mail client settings” in cPanel (Email Accounts → Connect Devices) and copy them in.</p>
        )}
        {data.source === 'env' && <p className="note">Currently sending from the server's own settings. Saving here moves them into Master Data.</p>}
        <button type="button" className="btn btn-primary blueprint" style={{ marginTop: 'var(--space-3)' }} onClick={() => setOpen(true)}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          {data.configured ? 'Edit mail client settings' : 'Set up mail client settings'}
        </button>
      </Card>

      {open && (
        <MailDialog
          current={data}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setMsg('Email settings saved');
            reload();
          }}
        />
      )}
    </div>
  );
}

function MailDialog({ current, onClose, onSaved }: { current: Mail; onClose: () => void; onSaved: () => void }) {
  const branding = useBranding();
  const [f, setF] = useState(blank);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setF({
      username: current.username,
      password: '',
      outgoingHost: current.outgoingHost,
      smtpPort: String(current.smtpPort),
      incomingHost: current.incomingHost,
      imapPort: String(current.imapPort),
      pop3Port: String(current.pop3Port),
      fromName: current.fromName,
      loginUrl: current.loginUrl,
    });
    setTestTo(current.username);
  }, [current]);

  const set = (k: keyof typeof blank, v: string) => setF((x) => ({ ...x, [k]: v }));
  const body = () => ({
    username: f.username,
    password: f.password,
    outgoingHost: f.outgoingHost,
    smtpPort: Number(f.smtpPort) || 465,
    incomingHost: f.incomingHost,
    imapPort: Number(f.imapPort) || 993,
    pop3Port: Number(f.pop3Port) || 995,
    fromName: f.fromName,
    loginUrl: f.loginUrl,
  });

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await api.put('/master-data/mail', body());
      onSaved();
      onClose();
      return '';
    });
  const test = () =>
    run(async () => {
      await api.put('/master-data/mail', body()); // test what is typed, so save it first
      const r = await api.post<{ sentTo: string }>('/master-data/mail/test', { to: testTo });
      onSaved();
      return `Connected and sent — check ${r.sentTo} for the test message`;
    });

  const row = { verticalAlign: 'top' as const };
  const label = { width: 118, color: 'var(--color-text-muted)', fontWeight: 600 };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" style={{ width: 'min(700px, 100%)', padding: 0, gap: 0, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ background: 'var(--color-accent)', color: 'var(--color-bg)', padding: 'var(--space-3) var(--space-4)', fontFamily: 'var(--font-heading)', fontSize: 19 }}>
          Secure SSL/TLS Settings (Recommended)
        </div>

        <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
          <Notice error={err} message={msg} />
          <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <tbody>
              <tr style={row}>
                <td style={label}>Username:</td>
                <td>
                  <input className="input" value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="admin@glmgroup.co.ke" autoComplete="off" />
                </td>
              </tr>
              <tr style={row}>
                <td style={label}>Password:</td>
                <td>
                  <input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={current.hasPassword ? '•••••••• saved — leave blank to keep' : ''} autoComplete="new-password" />
                  <div className="note" style={{ fontStyle: 'italic' }}>Use the email account’s password.</div>
                </td>
              </tr>
              <tr style={row}>
                <td style={label}>Incoming Server:</td>
                <td>
                  <input className="input" value={f.incomingHost} onChange={(e) => set('incomingHost', e.target.value)} placeholder="mail.glmgroup.co.ke" />
                  <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      IMAP Port: <input className="input" style={{ width: 80 }} inputMode="numeric" value={f.imapPort} onChange={(e) => set('imapPort', e.target.value.replace(/\D/g, ''))} />
                    </label>
                    <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      POP3 Port: <input className="input" style={{ width: 80 }} inputMode="numeric" value={f.pop3Port} onChange={(e) => set('pop3Port', e.target.value.replace(/\D/g, ''))} />
                    </label>
                  </div>
                </td>
              </tr>
              <tr style={row}>
                <td style={label}>Outgoing Server:</td>
                <td>
                  <input className="input" value={f.outgoingHost} onChange={(e) => set('outgoingHost', e.target.value)} placeholder="mail.glmgroup.co.ke" />
                  <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
                    SMTP Port: <input className="input" style={{ width: 80 }} inputMode="numeric" value={f.smtpPort} onChange={(e) => set('smtpPort', e.target.value.replace(/\D/g, ''))} />
                    <span className="note">465 = SSL/TLS (recommended)</span>
                  </label>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="note">IMAP, POP3, and SMTP require authentication. This system only sends mail, so the outgoing server is what matters; the incoming details are kept for reference.</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
            <div className="field">
              <label>Send as (display name)</label>
              <input className="input" value={f.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder={branding?.systemName ?? 'Your company'} />
            </div>
            <div className="field">
              <label>Sign-in address quoted in PIN emails</label>
              <input className="input" value={f.loginUrl} onChange={(e) => set('loginUrl', e.target.value)} placeholder="https://pos.glmgroup.co.ke" />
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--color-divider)', marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)' }}>
            <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
              Try it
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Send a test email to…" />
              <button type="button" className="btn btn-secondary" onClick={test} disabled={busy || !testTo.trim() || !f.username || !f.outgoingHost}>
                Save &amp; send test
              </button>
            </div>
          </div>

          <div className="dialog-actions" style={{ marginTop: 'var(--space-4)' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              Save settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
