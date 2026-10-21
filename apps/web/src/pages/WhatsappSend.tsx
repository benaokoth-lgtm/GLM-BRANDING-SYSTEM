import { useEffect, useState } from 'react';
import { api } from '../api/client';
import WhatsappFileSend from '../components/WhatsappFileSend';
import { Card, Notice } from './accounting/shared';

// Send a document: pick any file with the paperclip and send it straight to a phone number on WhatsApp — no order needed (artwork proofs, a price list, a contract, a statement saved as a PDF).
// Works once an Admin has set WhatsApp up under Master Data → WhatsApp.

interface Recent {
  id: number;
  to: string;
  status: string;
  mode: string;
  fileName: string;
  error: string;
  sentByName: string;
  at: string;
}

export default function WhatsappSend() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [to, setTo] = useState('');
  const [customer, setCustomer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);

  const loadRecent = () => api.get<Recent[]>('/whatsapp/recent').then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    api.get<{ ready: boolean }>('/whatsapp/status').then((r) => setReady(r.ready)).catch(() => setReady(false));
    loadRecent();
  }, []);

  return (
    <>
      <div>
        <div className="card-kicker">Sales</div>
        <div className="card-title">Send a document on WhatsApp</div>
      </div>
      <Notice error={error ?? undefined} />
      {ready === false && (
        <Notice error="WhatsApp isn't connected yet. An Admin sets it up under Master Data → WhatsApp (the Meta setup is in the user guide). Until then use the WhatsApp buttons on an order, which open your own WhatsApp." />
      )}
      <Card title="To whom" hint="The customer’s WhatsApp number, with or without the country code.">
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 220px', maxWidth: 280 }}>
            <label>WhatsApp number</label>
            <input className="input" type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0797 785 033" autoFocus />
          </div>
          <div className="field" style={{ flex: '1 1 220px', maxWidth: 320 }}>
            <label>Customer’s name (optional)</label>
            <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Wanjiru Kamau" />
          </div>
        </div>
      </Card>
      <Card title="The file" hint="Press the paperclip, choose the file, then send it.">
        {ready ? <WhatsappFileSend to={to} customer={customer} onError={setError} onSent={loadRecent} /> : <p className="note">{ready === null ? 'Checking WhatsApp…' : 'Sending is switched off until WhatsApp is connected.'}</p>}
      </Card>
      {recent.length > 0 && (
        <Card title="Recently sent">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>To</th>
                  <th>File</th>
                  <th>By</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>+{r.to}</td>
                    <td>{r.fileName || 'Order document'}</td>
                    <td>{r.sentByName}</td>
                    <td>{r.status === 'Sent' ? <span className="tag tag-accent">Sent</span> : <span title={r.error}>Failed — {r.error.slice(0, 70)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
