import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → WhatsApp: connects the system to Meta's WhatsApp Business (Cloud) API so an invoice or quotation can be sent straight to a customer's
// WhatsApp as a PDF. The access token is never shown again once saved.

interface Settings {
  enabled: boolean;
  configured: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  hasToken: boolean;
  templateName: string;
  templateLanguage: string;
  apiVersion: string;
  templateBody: string;
}

interface Checked {
  displayPhoneNumber: string;
  verifiedName: string;
  quality: string;
}

export default function WhatsappSettingsPanel() {
  const { data, error, loading, reload } = useLoad<Settings>('/whatsapp/settings');
  const [f, setF] = useState({ phoneNumberId: '', businessAccountId: '', accessToken: '', templateName: '', templateLanguage: 'en', enabled: false });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);

  useEffect(() => {
    if (!data) return;
    setF({ phoneNumberId: data.phoneNumberId, businessAccountId: data.businessAccountId, accessToken: '', templateName: data.templateName, templateLanguage: data.templateLanguage, enabled: data.enabled });
  }, [data]);

  if (!data) return <Loading loading={loading} error={error} />;
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

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

  const body = () => ({ phoneNumberId: f.phoneNumberId, businessAccountId: f.businessAccountId, accessToken: f.accessToken, templateName: f.templateName, templateLanguage: f.templateLanguage, enabled: f.enabled });
  const save = () =>
    run(async () => {
      await api.put('/whatsapp/settings', body());
      set('accessToken', '');
      return 'WhatsApp settings saved';
    });
  const saveAndTest = () =>
    run(async () => {
      await api.put('/whatsapp/settings', body());
      set('accessToken', '');
      const r = await api.post<Checked>('/whatsapp/settings/test');
      setChecked(r);
      return `Connected: ${r.verifiedName || 'your business'} ${r.displayPhoneNumber}${r.quality ? ` · quality ${r.quality}` : ''}`;
    });

  const ready = data.configured && data.enabled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 820 }}>
      <Notice error={err || error} message={msg} />
      <Card
        title="WhatsApp"
        hint="Send an invoice or quotation straight to a customer's WhatsApp as a PDF, with one button on the order. This uses Meta's official WhatsApp Business (Cloud) API."
        actions={<Tag tone={ready ? 'good' : 'neutral'}>{ready ? 'On' : data.configured ? 'Saved, switched off' : 'Not set up'}</Tag>}
      >
        <p className="note" style={{ marginTop: 0 }}>
          Set it up in Meta first (Business account, a phone number, an app, a permanent token and an approved template), then copy the details here. The step-by-step guide covers each of them.
          Never share the access token with anyone: it can send messages as your company. It is stored sealed and is not shown again.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Phone number ID</label>
            <input className="input" inputMode="numeric" value={f.phoneNumberId} onChange={(e) => set('phoneNumberId', e.target.value.replace(/\D/g, ''))} placeholder="from WhatsApp → API Setup" autoComplete="off" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>WhatsApp Business Account ID</label>
            <input className="input" inputMode="numeric" value={f.businessAccountId} onChange={(e) => set('businessAccountId', e.target.value.replace(/\D/g, ''))} placeholder="from WhatsApp → API Setup" autoComplete="off" />
          </div>
          <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <label>Access token (permanent System User token)</label>
            <input className="input" type="password" value={f.accessToken} onChange={(e) => set('accessToken', e.target.value)} placeholder={data.hasToken ? '•••••••• saved — leave blank to keep' : 'paste it here, and nowhere else'} autoComplete="new-password" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Template name</label>
            <input className="input" value={f.templateName} onChange={(e) => set('templateName', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="glm_invoice_pdf" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Template language code</label>
            <input className="input" style={{ maxWidth: 140 }} value={f.templateLanguage} onChange={(e) => set('templateLanguage', e.target.value.trim())} placeholder="en" />
          </div>
        </div>

        <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-3)', fontWeight: 400 }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Switch on: show “Send to the customer now” on invoices and quotations
        </label>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
          <button type="button" className="btn btn-primary" onClick={saveAndTest} disabled={busy || !f.phoneNumberId || !(f.accessToken || data.hasToken)}>
            Save and test the connection
          </button>
          <button type="button" className="btn btn-secondary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
        {checked && (
          <p className="note" style={{ marginBottom: 0 }}>
            WhatsApp says this is <b>{checked.verifiedName || 'a business'}</b> {checked.displayPhoneNumber}. If that is not your company’s number, the Phone number ID is the test number’s: use the ID of your own number.
          </p>
        )}
      </Card>

      <Card title="The template to create in Meta" hint="A business can only start a WhatsApp conversation with an approved template. Create it in WhatsApp Manager → Message templates, exactly like this.">
        <table className="table">
          <tbody>
            <tr>
              <td className="text-muted" style={{ width: 150 }}>Category</td>
              <td>Utility</td>
            </tr>
            <tr>
              <td className="text-muted">Name</td>
              <td>
                <code>glm_invoice_pdf</code> (or your own, then enter it above)
              </td>
            </tr>
            <tr>
              <td className="text-muted">Header</td>
              <td>Document (upload any sample PDF)</td>
            </tr>
            <tr>
              <td className="text-muted">Body</td>
              <td>
                <code style={{ overflowWrap: 'anywhere' }}>{data.templateBody}</code>
              </td>
            </tr>
            <tr>
              <td className="text-muted">What fills the five values</td>
              <td>
                1 customer name · 2 invoice / quotation / receipt · 3 the document number · 4 the total · 5 the balance due, or “Paid in full, thank you.”
              </td>
            </tr>
            <tr>
              <td className="text-muted">Buttons, footer</td>
              <td>None</td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ marginBottom: 0 }}>
          With no template name saved, the system tries a plain document message instead, which WhatsApp accepts only within 24 hours of the customer last writing to you. Wait for Meta to show the template as <b>Approved</b> before relying on it.
        </p>
      </Card>
    </div>
  );
}
