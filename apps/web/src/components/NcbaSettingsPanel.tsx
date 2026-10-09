import { useEffect, useState } from 'react';
import { fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → NCBA: Lipa na M-Pesa through NCBA Bank on Paybill 880100. NCBA sends the STK prompt to the customer's phone and tells us about every payment.
// Nothing secret is shown again once saved: leave a field blank to keep what is saved. Switching NCBA on sends the "Send M-Pesa STK push" button through NCBA
// instead of Safaricom's Daraja.

interface Settings {
  enabled: boolean;
  ready: boolean;
  baseUrl: string;
  apiUsername: string;
  hasApiSecret: boolean;
  payBillNo: string;
  accountNo: string;
  network: string;
  publicBaseUrl: string;
  notifyUrl: string | null;
  pushUser: string;
  hasPushCredentials: boolean;
  checkHash: boolean;
  notificationsReady: boolean;
  activity: { lastAt: string | null; held: number; rejectedLastWeek: number };
}

interface Received {
  id: number;
  receivedAt: string;
  transId: string;
  amount: number;
  billRef: string;
  phone: string;
  payerName: string;
  outcome: string;
  note: string;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <div className="note">{label}</div>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const OUTCOME_TONE: Record<string, 'good' | 'neutral' | 'bad'> = { Matched: 'good', Received: 'good', Duplicate: 'neutral', Held: 'bad', Rejected: 'bad' };

export default function NcbaSettingsPanel() {
  const { data, error, loading, reload } = useLoad<Settings>('/ncba/settings');
  const log = useLoad<Received[]>('/ncba/notifications');
  const [form, setForm] = useState({ baseUrl: '', apiUsername: '', apiSecret: '', payBillNo: '880100', accountNo: '', publicBaseUrl: '' });
  // The credentials just made, shown once: the notification set (NCBA uses it to call us) and the STK push set (we use it to call NCBA).
  const [fresh, setFresh] = useState<{ push?: { pushUser: string; pushPassword: string; pushSecret: string }; stk?: { apiUsername: string; apiSecret: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (data) setForm((f) => ({ ...f, baseUrl: data.baseUrl, apiUsername: data.apiUsername, apiSecret: '', payBillNo: data.payBillNo, accountNo: data.accountNo, publicBaseUrl: data.publicBaseUrl }));
  }, [data]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      reload();
      log.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await api.put('/ncba/settings', form);
      return 'NCBA settings saved';
    });
  const test = () =>
    run(async () => {
      await api.put('/ncba/settings', form);
      await api.post('/ncba/settings/test', {});
      return 'Connected — NCBA accepted the API username and secret key';
    });
  const toggle = (enabled: boolean) =>
    run(async () => {
      await api.put('/ncba/settings', { ...form, enabled });
      return enabled ? 'NCBA is switched on: STK prompts now go through NCBA' : 'NCBA is switched off: STK prompts go through M-Pesa (Safaricom) again';
    });
  // NCBA's request form asks for two separate sets: the API Push Notification credentials (NCBA signs in to us with them) and the STK Push credentials (we sign in to
  // NCBA with them). Both are made here, together or one at a time, shown once, and kept sealed.
  const makeCredentials = (which: 'both' | 'push' | 'stk') =>
    run(async () => {
      const replacing = (which !== 'stk' && data?.hasPushCredentials) || (which !== 'push' && data?.hasApiSecret);
      if (replacing && !window.confirm('Make new credentials? Any set NCBA has already been given stops working until NCBA is given the new one.')) return 'Nothing changed';
      await api.put('/ncba/settings', { ...form, apiUsername: undefined, apiSecret: undefined });
      const out: NonNullable<typeof fresh> = {};
      if (which !== 'stk') out.push = await api.post<{ pushUser: string; pushPassword: string; pushSecret: string }>('/ncba/credentials/generate', {});
      if (which !== 'push') out.stk = await api.post<{ apiUsername: string; apiSecret: string }>('/ncba/credentials/generate-stk', {});
      setFresh((f) => ({ ...f, ...out }));
      return 'Made — copy them onto the NCBA form now; they are not shown again';
    });
  const setCheckHash = (checkHash: boolean) =>
    run(async () => {
      if (!checkHash && !window.confirm("Stop checking the signature on NCBA's notifications?\n\nThey will still need your secret address and the username and password, but a payment is booked even if its signature does not match. Do this only if every real payment shows as Held because NCBA's signature layout differs from the guide — and switch it back on once that is sorted out.")) return 'Nothing changed';
      await api.put('/ncba/settings', { checkHash });
      return checkHash ? 'Signatures are checked again' : 'Signatures are no longer checked — the secret address, username and password still are';
    });
  const accept = (n: Received) =>
    run(async () => {
      if (!window.confirm(`Book ${fmtKsh(n.amount)} (${n.transId}) from ${n.payerName || 'an unknown payer'}? Do this only after checking the payment really arrived in the NCBA account.`)) return 'Nothing changed';
      await api.post(`/ncba/notifications/${n.id}/accept`, {});
      return `${n.transId} was booked`;
    });

  if (!data) return <Loading loading={loading} error={error} />;

  const needSecretHint = data.hasApiSecret ? '•••••••• saved — leave blank to keep' : '';
  const complete = data.hasApiSecret && !!data.apiUsername && !!data.payBillNo && !!data.accountNo;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 'var(--space-4)', alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Card
          title="NCBA request form — the details to give NCBA"
          hint="NCBA's form (Request – STK Push and/or API Push Notification) asks for two separate sets: the API Push Notification set, which NCBA uses to call this system, and the STK Push set, which this system uses to call NCBA. Both are made here; copy them onto the form."
        >
          <p className="note" style={{ marginTop: 0 }}>
            On the form tick <b>STK Push Service</b> and <b>API Push Notification Service</b>, choose <b>JSON</b> as the request format, and give your NCBA account number and your Till / Paybill / Buy Goods numbers (Paybill 880100 is NCBA's own shared Paybill; write your NCBA Till number if you have one).
          </p>
          {data.notifyUrl ? <CopyLine label="Form → API Push Notification Configuration → Endpoint / URL" value={data.notifyUrl} /> : <p className="note">Save this system's public web address below first — the Endpoint / URL is built from it.</p>}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !data.notifyUrl} onClick={() => makeCredentials('both')}>
              {data.hasPushCredentials && data.hasApiSecret ? 'Make both sets again' : 'Make both sets of credentials'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !data.notifyUrl} onClick={() => makeCredentials('push')}>
              Notification set only
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => makeCredentials('stk')}>
              STK push set only
            </button>
          </div>
          {fresh && (
            <div className="blueprint" style={{ padding: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <strong>Copy these onto the NCBA form now — they will not be shown again.</strong>
              {fresh.push && (
                <>
                  <div className="card-kicker" style={{ marginTop: 'var(--space-3)' }}>API Push Notification Configuration → Integration Details</div>
                  <CopyLine label="Username" value={fresh.push.pushUser} />
                  <CopyLine label="Password" value={fresh.push.pushPassword} />
                  <CopyLine label="Secret Key" value={fresh.push.pushSecret} />
                </>
              )}
              {fresh.stk && (
                <>
                  <div className="card-kicker" style={{ marginTop: 'var(--space-3)' }}>STK Push Credentials</div>
                  <CopyLine label="Username" value={fresh.stk.apiUsername} />
                  <CopyLine label="Secret Key" value={fresh.stk.apiSecret} />
                </>
              )}
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-3)' }} onClick={() => setFresh(null)}>
                I have copied them
              </button>
            </div>
          )}
          {!fresh && (
            <p className="note" style={{ marginBottom: 0 }}>
              {data.hasPushCredentials ? `Notification set made (username ${data.pushUser}). ` : 'Notification set not made yet. '}
              {data.hasApiSecret ? `STK push set made (username ${data.apiUsername}). ` : 'STK push set not made yet. '}
              Passwords and secret keys are kept sealed and cannot be shown again — make new ones if they are lost, and give NCBA the new ones.
            </p>
          )}
        </Card>

        <Card
          title="NCBA — Paybill 880100"
          hint="Send the payment prompt (STK push) to the customer's phone through NCBA. While this is on, the 'Send M-Pesa STK push' buttons use NCBA instead of Safaricom. The STK push credentials are made above; once NCBA has activated them, press Save & test connection."
          actions={<Tag tone={data.enabled ? 'good' : 'neutral'}>{data.enabled ? 'On' : 'Off'}</Tag>}
        >
          <Notice error={err} message={msg} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div className="field">
              <label>STK push username (the one on your request form to NCBA)</label>
              <input className="input" value={form.apiUsername} onChange={(e) => setForm((f) => ({ ...f, apiUsername: e.target.value }))} autoComplete="off" />
            </div>
            <div className="field">
              <label>STK push secret key</label>
              <input className="input" type="password" value={form.apiSecret} placeholder={needSecretHint} onChange={(e) => setForm((f) => ({ ...f, apiSecret: e.target.value }))} autoComplete="new-password" />
            </div>
            <div className="field">
              <label>Paybill number</label>
              <input className="input" inputMode="numeric" value={form.payBillNo} onChange={(e) => setForm((f) => ({ ...f, payBillNo: e.target.value }))} />
            </div>
            <div className="field">
              <label>Account number / Till short code (sent with each prompt)</label>
              <input className="input" value={form.accountNo} onChange={(e) => setForm((f) => ({ ...f, accountNo: e.target.value }))} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>This system's public web address (https://…) — NCBA must be able to reach it</label>
              <input className="input" value={form.publicBaseUrl} onChange={(e) => setForm((f) => ({ ...f, publicBaseUrl: e.target.value }))} placeholder="https://pos.yourcompany.co.ke" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>NCBA address (leave as it is unless NCBA gave you a test address)</label>
              <input className="input" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
              Save
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy || !(complete || (form.apiUsername && form.apiSecret))} onClick={test}>
              Save &amp; test connection
            </button>
            {data.enabled ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => toggle(false)}>
                Switch NCBA off
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" disabled={busy || !complete || !data.hasPushCredentials} title={!data.hasPushCredentials ? 'Make the credentials and give them to NCBA first' : undefined} onClick={() => toggle(true)}>
                Switch NCBA on
              </button>
            )}
          </div>
        </Card>

        <Card
          title="Payment notifications from NCBA"
          hint="NCBA's push notification service: it posts every payment made to the Paybill to this address. Each call carries a username, password and signature made from the secret key; only calls that carry yours are booked. This works on its own — it does not need the STK push to be switched on."
          actions={<Tag tone={data.notificationsReady ? 'good' : 'neutral'}>{data.notificationsReady ? 'Ready to receive' : 'Not ready'}</Tag>}
        >
          {data.notificationsReady ? (
            <p className="note" style={{ marginTop: 0 }}>
              {data.activity.lastAt ? `Last notification received ${new Date(data.activity.lastAt).toLocaleString('en-KE')}.` : 'Nothing received yet — once NCBA has been given the address and credentials below, every payment will show up on the right.'}
              {data.activity.held > 0 && <b> {data.activity.held} held for you to check.</b>}
              {data.activity.rejectedLastWeek > 0 && ` ${data.activity.rejectedLastWeek} refused in the last week (wrong username or password).`}
            </p>
          ) : (
            <p className="note" style={{ marginTop: 0 }}>To be ready: save this system's public web address, and make the credentials in the request-form card above.</p>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 'var(--space-3)', fontSize: 14 }}>
            <input type="checkbox" checked={data.checkHash} disabled={busy} onChange={(e) => setCheckHash(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Check the signature on every notification <span className="text-muted">(recommended). A notification whose signature does not match is held for you instead of being booked.</span>
            </span>
          </label>
        </Card>
      </div>

      <Card title="What NCBA has sent" hint="The last payments NCBA told us about, and what became of each.">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => log.reload()}>
          Refresh
        </button>
        {!log.data ? (
          <Loading loading={log.loading} error={log.error} />
        ) : log.data.length === 0 ? (
          <p className="note">Nothing yet. Once NCBA is told the address and credentials, every payment shows up here.</p>
        ) : (
          <table className="table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Receipt</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((n) => (
                <tr key={n.id}>
                  <td className="text-muted">{fmtDate(n.receivedAt.slice(0, 10))}</td>
                  <td title={`${n.payerName} ${n.billRef}`.trim()}>{n.transId || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(n.amount)}</td>
                  <td title={n.note}>
                    <Tag tone={OUTCOME_TONE[n.outcome] ?? 'neutral'}>{n.outcome}</Tag>
                    {n.outcome === 'Held' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => accept(n)}>
                        Accept
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note">
          <b>Held</b> means the signature on the notification did not check out, so nothing was booked. Check the payment in your NCBA account; if it is real, Accept it.
          <b> Rejected</b> means the username or password was not yours.
        </p>
      </Card>
    </div>
  );
}
