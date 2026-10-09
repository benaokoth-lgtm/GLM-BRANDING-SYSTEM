import { useState } from 'react';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';

// Finance → Corporate Clients (it used to live in Master Data). The companies billed on credit: their credit terms, and the email / phone that prefill
// "Send email" / "Send WhatsApp" on their invoices and quotations.
export default function CorporateClientsPanel() {
  const catalog = useCatalog();
  const [newName, setNewName] = useState('');
  const [newCreditDays, setNewCreditDays] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [drafts, setDrafts] = useState<Record<number, { email?: string; phone?: string; contactPerson?: string }>>({});
  const [error, setError] = useState<string | null>(null);

  async function addClient() {
    const days = Number(newCreditDays) || 30;
    if (!newName.trim()) return setError('Client name is required');
    setError(null);
    try {
      await api.post('/master-data/corporate-clients', { name: newName, creditDays: days, email: newEmail, phone: newPhone, contactPerson: newContact });
      setNewName('');
      setNewCreditDays('');
      setNewContact('');
      setNewEmail('');
      setNewPhone('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add corporate client');
    }
  }

  async function saveField(clientId: number, field: 'email' | 'phone' | 'contactPerson', value: string) {
    setError(null);
    try {
      await api.put(`/master-data/corporate-clients/${clientId}`, { [field]: value });
      setDrafts((d) => ({ ...d, [clientId]: { ...d[clientId], [field]: undefined } }));
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update client');
    }
  }

  return (
    <>
      {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Corporate client</th>
            <th>Credit terms</th>
            <th>Contact person</th>
            <th>Email</th>
            <th>Phone</th>
          </tr>
        </thead>
        <tbody>
          {catalog.corporateClients.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="text-muted">{c.creditDays} days</td>
              <td>
                <input
                  className="input"
                  style={{ minWidth: 150 }}
                  value={drafts[c.id]?.contactPerson ?? c.contactPerson ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], contactPerson: e.target.value } }))}
                  onBlur={(e) => saveField(c.id, 'contactPerson', e.target.value)}
                  placeholder="Optional"
                />
              </td>
              <td>
                <input
                  className="input"
                  style={{ minWidth: 160 }}
                  value={drafts[c.id]?.email ?? c.email}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], email: e.target.value } }))}
                  onBlur={(e) => saveField(c.id, 'email', e.target.value)}
                  placeholder="Optional"
                />
              </td>
              <td>
                <input
                  className="input"
                  style={{ minWidth: 140 }}
                  value={drafts[c.id]?.phone ?? c.phone}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], phone: e.target.value } }))}
                  onBlur={(e) => saveField(c.id, 'phone', e.target.value)}
                  placeholder="Optional"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        The contact person is printed as "Attn:" on that client's invoices and quotations. Email and phone prefill the "Send email"/"Send WhatsApp" targets.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.7fr 1fr 1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 960 }}>
        <div className="field">
          <label>New corporate client</label>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="field">
          <label>Credit terms (days)</label>
          <input className="input" value={newCreditDays} onChange={(e) => setNewCreditDays(e.target.value)} />
        </div>
        <div className="field">
          <label>Contact person</label>
          <input className="input" value={newContact} onChange={(e) => setNewContact(e.target.value)} placeholder="Optional" />
        </div>
        <div className="field">
          <label>Email</label>
          <input className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Optional" />
        </div>
        <div className="field">
          <label>Phone</label>
          <input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Optional" />
        </div>
        <button type="button" className="btn btn-primary blueprint" onClick={addClient}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Add
        </button>
      </div>
    </>
  );
}
