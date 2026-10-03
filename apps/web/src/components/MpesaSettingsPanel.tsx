import { useEffect, useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → M-Pesa: the Admin sets up the Paybill/Till and Safaricom (Daraja) credentials here instead of in server files.
// The consumer secret and passkey are never shown again once saved — the page only says they are set; leave a field blank to keep it.

interface Settings {
  source: 'settings' | 'env';
  enabled: boolean;
  ready: boolean;
  environment: 'sandbox' | 'production';
  shortCode: string;
  isTill: boolean;
  publicBaseUrl: string;
  hasConsumerKey: boolean;
  hasConsumerSecret: boolean;
  hasPasskey: boolean;
  c2bRegisteredAt: string | null;
  callbackUrls: { stk: string; validation: string; confirmation: string } | null;
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

export default function MpesaSettingsPanel() {
  const { data, error, loading, reload } = useLoad<Settings>('/mpesa/settings');
  const [form, setForm] = useState({ environment: 'sandbox', shortCode: '', isTill: false, publicBaseUrl: '', consumerKey: '', consumerSecret: '', passkey: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (data) setForm((f) => ({ ...f, environment: data.environment, shortCode: data.shortCode, isTill: data.isTill, publicBaseUrl: data.publicBaseUrl, consumerKey: '', consumerSecret: '', passkey: '' }));
  }, [data]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => {
    await api.put('/mpesa/settings', form);
    return 'M-Pesa settings saved';
  });
  const test = () =>
    run(async () => {
      // Test what is saved — so save any typed changes first.
      await api.put('/mpesa/settings', form);
      await api.post('/mpesa/settings/test', {});
      return 'Connected — Safaricom accepted the consumer key and secret';
    });
  const toggle = (enabled: boolean) =>
    run(async () => {
      await api.put('/mpesa/settings', { ...form, enabled });
      return enabled ? 'M-Pesa is switched on' : 'M-Pesa is switched off';
    });
  const register = () =>
    run(async () => {
      await api.put('/mpesa/settings', form);
      await api.post('/mpesa/settings/register-c2b', {});
      return 'Registered — Safaricom will now tell us about Paybill/Till payments made without a prompt';
    });

  if (!data) return <Loading loading={loading} error={error} />;

  const needSecretHint = (has: boolean) => (has ? '•••••••• saved — leave blank to keep' : '');
  const complete = data.hasConsumerKey && data.hasConsumerSecret && data.hasPasskey && !!data.shortCode;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 'var(--space-4)', alignItems: 'start' }}>
      <Card
        title="M-Pesa"
        hint="Send a payment prompt (STK push) to a customer's phone from General, Film and Artwork orders and Record payment — and match Paybill/Till payments Safaricom tells us about on its own."
        actions={<Tag tone={data.enabled ? 'good' : 'neutral'}>{data.enabled ? 'On' : 'Off'}</Tag>}
      >
        <Notice error={err} message={msg} />
        {data.source === 'env' && (
          <p className="note">This install is still running on the server's own M-Pesa settings. Saving here moves them into Master Data so you can manage them without touching server files.</p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="field">
            <label>Environment</label>
            <select className="input" value={form.environment} onChange={(e) => setForm((f) => ({ ...f, environment: e.target.value }))}>
              <option value="sandbox">Sandbox (testing)</option>
              <option value="production">Production (live money)</option>
            </select>
          </div>
          <div className="field">
            <label>Paybill / Till number</label>
            <input className="input" inputMode="numeric" value={form.shortCode} onChange={(e) => setForm((f) => ({ ...f, shortCode: e.target.value }))} />
          </div>
        </div>
        <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', margin: 'var(--space-2) 0 var(--space-3)' }}>
          <input type="checkbox" checked={form.isTill} onChange={(e) => setForm((f) => ({ ...f, isTill: e.target.checked }))} /> This is a Till (Buy Goods) number, not a Paybill
        </label>

        <div className="field">
          <label>This installation's public web address</label>
          <input className="input" placeholder="https://api.glmgroup.co.ke" value={form.publicBaseUrl} onChange={(e) => setForm((f) => ({ ...f, publicBaseUrl: e.target.value }))} />
          <div className="note">Safaricom must be able to reach this address over the internet to tell us a payment went through. Use the API's own address (where this system's server runs), starting with https://.</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <div className="field">
            <label>Consumer key</label>
            <input className="input" type="password" autoComplete="off" placeholder={needSecretHint(data.hasConsumerKey)} value={form.consumerKey} onChange={(e) => setForm((f) => ({ ...f, consumerKey: e.target.value }))} />
          </div>
          <div className="field">
            <label>Consumer secret</label>
            <input className="input" type="password" autoComplete="off" placeholder={needSecretHint(data.hasConsumerSecret)} value={form.consumerSecret} onChange={(e) => setForm((f) => ({ ...f, consumerSecret: e.target.value }))} />
          </div>
          <div className="field">
            <label>Passkey</label>
            <input className="input" type="password" autoComplete="off" placeholder={needSecretHint(data.hasPasskey)} value={form.passkey} onChange={(e) => setForm((f) => ({ ...f, passkey: e.target.value }))} />
          </div>
        </div>
        <p className="note">Leave a field blank to keep what is already saved. These come from Safaricom's Daraja portal, against your Paybill or Till.</p>

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-secondary" onClick={test} disabled={busy || !(data.hasConsumerKey || form.consumerKey)}>
            Test the connection
          </button>
          {data.enabled ? (
            <button type="button" className="btn btn-secondary" onClick={() => toggle(false)} disabled={busy}>
              Switch off
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => toggle(true)} disabled={busy || !complete} title={complete ? '' : 'Save the number, key, secret and passkey first'}>
              Switch on
            </button>
          )}
        </div>
        {data.environment === 'sandbox' && data.enabled && <p className="note">Sandbox is for testing — no real money moves. Switch to Production with your live Daraja keys when you are ready.</p>}
      </Card>

      <Card
        title="Paybill payments made without a prompt"
        hint="Customers sometimes pay your Paybill/Till directly instead of waiting for a prompt. Give Safaricom these addresses so it tells us. Print the order number on the bill and ask customers to use it as their account/reference — a payment naming an order is matched automatically; any other waits in Accounting → M-Pesa Matching."
      >
        {data.callbackUrls ? (
          <>
            <CopyLine label="STK push callback" value={data.callbackUrls.stk} />
            <CopyLine label="Confirmation address" value={data.callbackUrls.confirmation} />
            <CopyLine label="Validation address" value={data.callbackUrls.validation} />
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={register} disabled={busy || !complete}>
                Register these addresses with Safaricom
              </button>
              {data.c2bRegisteredAt ? <Tag tone="good">Registered {fmtDate(data.c2bRegisteredAt.slice(0, 10))}</Tag> : <Tag>Not registered yet</Tag>}
            </div>
            <p className="note">The addresses contain a long random secret, so only Safaricom can post payments to them. Registering needs M-Pesa saved with its keys, and a Production Paybill/Till.</p>
          </>
        ) : (
          <p className="note">Save a public web address above first — the callback addresses are built from it.</p>
        )}
      </Card>
    </div>
  );
}
