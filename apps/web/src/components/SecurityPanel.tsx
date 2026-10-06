import { useState } from 'react';
import { api } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → Security (Admin): which protections are on, the Admin sign-in code switch, and the audit log — who did what, when, from where.

interface Status {
  dataKey: boolean;
  unsealedSecrets: string[];
  jwtSecretStrong: boolean;
  requireAdminCode: boolean;
  mailConfigured: boolean;
  youHaveEmail: boolean;
  adminsWithoutEmail: string[];
  shortPinPeople: string[];
  activeUsers: number;
  switchedOff: number;
}
interface AuditRow {
  id: number;
  at: string;
  userName: string;
  role: string;
  method: string;
  action: string;
  path: string;
  status: number;
  detail: string;
  ip: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'medium' });

function Check({ ok, title, children }: { ok: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderTop: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
      <Tag tone={ok ? 'good' : 'bad'}>{ok ? 'OK' : 'Action'}</Tag>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        {children && <div className="note" style={{ margin: 0 }}>{children}</div>}
      </div>
    </div>
  );
}

export default function SecurityPanel() {
  const status = useLoad<Status>('/security/status');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(today());
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  async function loadAudit() {
    setBusy(true);
    setErr('');
    try {
      const params = new URLSearchParams({ from, to, limit: '500' });
      if (user.trim()) params.set('user', user.trim());
      if (q.trim()) params.set('q', q.trim());
      const r = await api.get<{ total: number; rows: AuditRow[] }>(`/security/audit?${params}`);
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the audit log');
    } finally {
      setBusy(false);
    }
  }

  async function setCode(on: boolean) {
    setErr('');
    setMsg('');
    try {
      await api.put('/security/settings', { requireAdminCode: on });
      setMsg(on ? 'Admins with an email address are now asked for an emailed code after their PIN.' : 'The Admin sign-in code is off.');
      status.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change the setting');
    }
  }

  const s = status.data;
  if (!s) return <Loading loading={status.loading} error={status.error} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 1100 }}>
      <Notice error={err || status.error} message={msg} />

      <Card title="Protection checklist" hint="What is switched on to protect the system and its data.">
        <Check ok={s.dataKey && s.unsealedSecrets.length === 0} title="Saved secrets and backup files are encrypted">
          {!s.dataKey ? (
            <>
              Not set up. The M-Pesa secret and passkey, the email password and the Google Drive secret are stored as plain text, and backup files are readable by anyone who gets a copy. Add a <b>DATA_KEY</b> to the server's settings (steps below).
            </>
          ) : s.unsealedSecrets.length > 0 ? (
            <>The key is set; these will be sealed the next time the system restarts: {s.unsealedSecrets.join(', ')}.</>
          ) : (
            <>On. Secrets are stored sealed, and every backup file is encrypted. Keep a copy of the key somewhere other than this server — without it, backups cannot be opened.</>
          )}
        </Check>
        <Check ok={s.jwtSecretStrong} title="Sessions are signed with a strong secret">
          {s.jwtSecretStrong ? 'A long random JWT_SECRET is in use.' : 'The server is using a built-in test secret. Set JWT_SECRET in the server settings.'}
        </Check>
        <Check ok={s.shortPinPeople.length === 0} title="PINs are as long as each role needs">
          {s.shortPinPeople.length === 0
            ? 'Everyone has a PIN of the length their role needs (6 digits for the Admin and anyone who handles money, costs, pay or the books; at least 4 for others).'
            : `${s.shortPinPeople.join(', ')} must choose a longer PIN the next time they sign in.`}
        </Check>
        <Check ok={s.requireAdminCode} title="Admin sign-in needs an emailed code as well as the PIN">
          <div>
            {s.requireAdminCode
              ? 'On: after their PIN, an Admin who has an email address is sent a 6-digit code to type in. (If the email cannot be sent, the Admin can still sign in on the PIN alone, and that is recorded.)'
              : 'Off. Switching it on means a guessed or shared Admin PIN is not enough to sign in.'}
            {s.adminsWithoutEmail.length > 0 && s.requireAdminCode && <> Not asked for a code (no email address): {s.adminsWithoutEmail.join(', ')}.</>}
          </div>
          <div style={{ marginTop: 'var(--space-1)' }}>
            {s.requireAdminCode ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCode(false)}>
                Switch off
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={!s.youHaveEmail || !s.mailConfigured} onClick={() => setCode(true)}>
                Switch on
              </button>
            )}
            {!s.requireAdminCode && !s.youHaveEmail && <span className="text-muted"> Add your own email address under Staff &amp; Users first.</span>}
            {!s.requireAdminCode && s.youHaveEmail && !s.mailConfigured && <span className="text-muted"> Set up the mail account under Email first.</span>}
          </div>
        </Check>
        <Check ok title="Sign-ins">
          {s.activeUsers} active, {s.switchedOff} switched off. Five wrong PINs lock a person out — 15 minutes the first time, then 30, 60 and so on up to a day.
        </Check>
      </Card>

      {!s.dataKey && (
        <Card title="Setting up the data key (one time, on the server)" hint="This is what makes secrets and backups unreadable to anyone without the key.">
          <ol style={{ lineHeight: 1.7, paddingLeft: 'var(--space-4)', marginTop: 0 }}>
            <li>
              Sign in to the server and run: <code>sudo bash /opt/glm-pos/deploy-vps/add-data-key.sh</code>
            </li>
            <li>It adds a random <b>DATA_KEY</b> to <code>/etc/glm-pos/api.env</code>, shows it to you once, and restarts the system.</li>
            <li>
              <b>Copy the key into a password manager straight away.</b> If it is lost, encrypted backups and sealed settings cannot be opened. Do not paste it into chat or email.
            </li>
            <li>Come back here: the first line above turns green, and new backups are encrypted.</li>
          </ol>
        </Card>
      )}

      <Card title="Audit log" hint="Every change made in the system, every refused request, sign-ins and sensitive downloads — who, when and from where. Passwords, PINs and codes are never recorded. Kept for two years.">
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Person</label>
            <input className="input" style={{ width: 150 }} value={user} onChange={(e) => setUser(e.target.value)} placeholder="name" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Search</label>
            <input className="input" style={{ width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="payments, LOGIN FAILED, refused …" onKeyDown={(e) => e.key === 'Enter' && loadAudit()} />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadAudit}>
            {busy ? 'Loading…' : 'Show'}
          </button>
        </div>
        {rows && (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'}{total > rows.length ? ` — showing the newest ${rows.length}; narrow the dates or search to see the rest` : ''}.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Details</th>
                    <th>Result</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(r.at)}</td>
                      <td>
                        {r.userName || <span className="text-muted">—</span>}
                        {r.role && <div className="text-muted" style={{ fontSize: 11 }}>{r.role}</div>}
                      </td>
                      <td>
                        <div>{r.action}</div>
                        {r.path && r.path !== r.action.replace(/^\w+ /, '') && <div className="text-muted" style={{ fontSize: 11 }}>{r.path}</div>}
                      </td>
                      <td style={{ maxWidth: 340, wordBreak: 'break-word' }}>{r.detail}</td>
                      <td>{r.status ? <Tag tone={r.status >= 400 ? 'bad' : 'neutral'}>{r.status}</Tag> : ''}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.ip}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-muted">
                        Nothing matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
