import { useEffect, useState } from 'react';
import { FREELANCE_PAY_METHODS } from '@glm/shared';
import { api } from '../api/client';

// Pick the freelance sales person who brought this order — or add them on the spot, with the details their account needs. A new person waits for
// a manager's approval before they are paid, but the order is credited to them straight away.

interface Agent {
  id: number;
  name: string;
  phoneTail: string;
  status: string;
}

const blank = { name: '', phone: '', mpesaNumber: '', nationalId: '', kraPin: '', bankName: '', bankAccount: '', payMethod: 'M-Pesa' };

export default function FreelancePicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Agent[]>('/freelance/pickable').then(setAgents).catch(() => setAgents([]));
  useEffect(() => {
    load();
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await api.post<Agent & { existing: boolean }>('/freelance/agents', {
        name: form.name,
        phone: form.phone,
        payMethod: form.payMethod,
        ...(form.mpesaNumber.trim() ? { mpesaNumber: form.mpesaNumber } : {}),
        ...(form.nationalId.trim() ? { nationalId: form.nationalId } : {}),
        ...(form.kraPin.trim() ? { kraPin: form.kraPin } : {}),
        ...(form.bankName.trim() ? { bankName: form.bankName } : {}),
        ...(form.bankAccount.trim() ? { bankAccount: form.bankAccount } : {}),
      });
      await load();
      onChange(r.id);
      setAdding(false);
      setForm(blank);
      setNote(r.existing ? `${r.name} already has an account (…${r.phoneTail}) — selected.` : r.status === 'Pending' ? `${r.name} is added. A manager approves them before they are paid; this order is credited to them now.` : `${r.name} is added.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add them');
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <select
        className="input"
        value={adding ? 'new' : value ?? ''}
        onChange={(e) => {
          if (e.target.value === 'new') {
            setAdding(true);
            onChange(null);
          } else {
            setAdding(false);
            setNote('');
            onChange(e.target.value ? Number(e.target.value) : null);
          }
        }}
      >
        <option value="">Choose the freelance sales person…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · …{a.phoneTail}
            {a.status === 'Pending' ? ' (awaiting approval)' : ''}
          </option>
        ))}
        <option value="new">+ A new freelance sales person…</option>
      </select>
      {note && <p className="note" style={{ margin: 0 }}>{note}</p>}
      {adding && (
        <div className="card" style={{ padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
          <div className="card-kicker">Their details — for crediting their account</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-2)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Full name *</label>
              <input className="input" value={form.name} onChange={set('name')} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Phone number *</label>
              <input className="input" inputMode="tel" value={form.phone} onChange={set('phone')} placeholder="0712 345 678" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>M-Pesa number (if different)</label>
              <input className="input" inputMode="tel" value={form.mpesaNumber} onChange={set('mpesaNumber')} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>National ID</label>
              <input className="input" value={form.nationalId} onChange={set('nationalId')} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>KRA PIN</label>
              <input className="input" value={form.kraPin} maxLength={11} onChange={(e) => setForm((f) => ({ ...f, kraPin: e.target.value.toUpperCase() }))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>How are they paid?</label>
              <select className="input" value={form.payMethod} onChange={(e) => setForm((f) => ({ ...f, payMethod: e.target.value }))}>
                {FREELANCE_PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Bank (optional)</label>
              <input className="input" value={form.bankName} onChange={set('bankName')} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Account number (optional)</label>
              <input className="input" value={form.bankAccount} onChange={set('bankAccount')} />
            </div>
          </div>
          {error && <p className="note" style={{ color: '#a33', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !form.name.trim() || !form.phone.trim()} onClick={save}>
              Add and credit this order to them
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAdding(false);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
