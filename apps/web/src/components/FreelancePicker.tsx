import { useEffect, useState } from 'react';
import { FREELANCE_PAY_METHODS } from '@glm/shared';
import { api } from '../api/client';

// Pick the freelance sales person who brought this order — or add them on the spot, with the details their account needs. A new person waits for
// a manager's approval before they are paid, but the order is credited to them straight away.

interface Agent {
  id: number;
  /** Register number, FL-001 … */
  code: string;
  name: string;
  phoneTail: string;
  status: string;
}

const blank = { name: '', phone: '', mpesaNumber: '', nationalId: '', kraPin: '', bankName: '', bankAccount: '', payMethod: 'M-Pesa' };

export default function FreelancePicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [chosen, setChosen] = useState<Agent | null>(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // The register, filtered as they type (by name, register number or phone number); the first few when nothing is typed.
  const load = (q = query) => api.get<Agent[]>(`/freelance/pickable?limit=8&q=${encodeURIComponent(q)}`).then(setAgents).catch(() => setAgents([]));
  useEffect(() => {
    const t = setTimeout(() => void load(query), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  // Who is already chosen (set by the parent, or just added): show them by name instead of the search box.
  useEffect(() => {
    if (!value) {
      setChosen(null);
      return;
    }
    if (chosen?.id === value) return;
    api.get<Agent[]>(`/freelance/pickable?id=${value}`).then((r) => setChosen(r[0] ?? null)).catch(() => setChosen(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
      setChosen(r);
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
      {value && chosen && !adding ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--color-divider)', padding: 'var(--space-2) var(--space-3)' }}>
          <b>{chosen.name}</b>
          <span className="text-muted">
            {chosen.code} · …{chosen.phoneTail}
            {chosen.status === 'Pending' ? ' · awaiting approval' : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setChosen(null); setQuery(''); setNote(''); onChange(null); }}>
            Change
          </button>
        </div>
      ) : (
        !adding && (
          <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the freelancers by name, phone or FL number…" aria-label="Search freelance sales persons" />
            <div style={{ border: '1px solid var(--color-divider)', maxHeight: 240, overflowY: 'auto' }}>
              {agents.length === 0 && <p className="note" style={{ margin: 'var(--space-2) var(--space-3)' }}>{query ? 'No one matches. Add them below.' : 'No freelance sales persons on the register yet. Add the first one below.'}</p>}
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="btn btn-ghost"
                  style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 'var(--space-2)', textAlign: 'left', borderBottom: '1px solid var(--color-divider)' }}
                  onClick={() => { setChosen(a); setNote(''); onChange(a.id); }}
                >
                  <span>
                    <b>{a.name}</b>
                    {a.status === 'Pending' ? <span className="text-muted"> · awaiting approval</span> : null}
                  </span>
                  <span className="text-muted">{a.code} · …{a.phoneTail}</span>
                </button>
              ))}
            </div>
            <div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setAdding(true); onChange(null); }}>
                + A new freelance sales person…
              </button>
            </div>
          </div>
        )
      )}
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
