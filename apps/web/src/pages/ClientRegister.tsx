import { useCallback, useEffect, useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { useCatalog } from '../hooks/useCatalog';

// Client Register: the clients each sales person has brought in, with name and phone. A sales person keeps their own list; the front office and commission managers keep anyone's. On an order screen
// the sales person is picked and then one of their clients, and the client's name and phone are filled in. It is the register commission already uses for clients credited to a staff member: a
// client belongs to one sales person at a time (for the months set in Commission → Rates), and their orders are credited to that person.

interface Person {
  id: number;
  name: string;
}
interface People {
  all: boolean;
  me: Person;
  people: Person[];
}
interface Client {
  id: number;
  name: string;
  phone: string;
  corporate: boolean;
  staffId: number;
  startDate: string;
  endDate: string;
  note: string;
}

export default function ClientRegister({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const { corporateClients } = useCatalog();
  const canRelease = user?.role === 'Admin' || !!user?.permissions.canManageCommission;
  const [people, setPeople] = useState<People | null>(null);
  const [staffId, setStaffId] = useState<number | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', corporateClientId: '' });
  const [editing, setEditing] = useState<{ id: number; name: string; phone: string } | null>(null);

  useEffect(() => {
    api
      .get<People>('/staff-clients/people')
      .then((p) => {
        setPeople(p);
        setStaffId(p.me.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the register'));
  }, []);

  const load = useCallback(() => {
    if (!staffId) return;
    api
      .get<Client[]>(`/staff-clients?staffId=${staffId}`)
      .then((r) => {
        setClients(r);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the clients'));
  }, [staffId]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      setNote(await fn());
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  if (!people) return <p className="note">{error || 'Loading…'}</p>;
  const owner = people.people.find((p) => p.id === staffId);
  const mine = staffId === people.me.id;
  const shown = clients.filter((c) => !search.trim() || `${c.name} ${c.phone}`.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        {embedded ? <h2 style={{ margin: 0 }}>Client Register</h2> : <h1 style={{ margin: 0 }}>Client Register</h1>}
        <p className="note" style={{ margin: '4px 0 0' }}>
          The clients each sales person has brought in. On an order, pick the sales person and then one of their clients: the name and phone are filled in. A client belongs to one sales person at a time,
          and their orders are credited to that person.
        </p>
      </div>

      {people.all && (
        <div className="field" style={{ maxWidth: 360, margin: 0 }}>
          <label>Whose clients</label>
          <select className="input" value={staffId ?? ''} onChange={(e) => setStaffId(Number(e.target.value))} aria-label="Whose clients">
            {people.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === people.me.id ? `${p.name} (me)` : p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
      {note && <p className="note" style={{ margin: 0 }}>{note}</p>}

      <div className="card" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div className="card-kicker">Add a client {mine ? '' : `for ${owner?.name ?? ''}`}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Client name</label>
            <input className="input" value={form.name} disabled={!!form.corporateClientId} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name of the person or business" aria-label="Client name" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Phone</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07xx xxx xxx" aria-label="Client phone" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Or a corporate account</label>
            <select className="input" value={form.corporateClientId} onChange={(e) => setForm({ ...form, corporateClientId: e.target.value })} aria-label="Corporate account">
              <option value="">—</option>
              {corporateClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !staffId || (!form.corporateClientId && (!form.name.trim() || !form.phone.trim()))}
            onClick={() =>
              run(async () => {
                const body = form.corporateClientId ? { staffId, corporateClientId: Number(form.corporateClientId), phone: form.phone.trim() || undefined } : { staffId, name: form.name.trim(), phone: form.phone.trim() };
                const c = await api.post<Client>('/staff-clients', body);
                setForm({ name: '', phone: '', corporateClientId: '' });
                return `${c.name} is now in ${mine ? 'your' : `${owner?.name ?? ''}’s`} register.`;
              })
            }
          >
            Add to the register
          </button>
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div className="card-kicker">{mine ? 'Your clients' : `${owner?.name ?? ''}’s clients`} ({clients.length})</div>
          {clients.length > 6 && <input className="input" style={{ maxWidth: 240 }} placeholder="Find a client" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find a client" />}
        </div>
        {clients.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>No clients in this register yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Phone</th>
                <th>Credited from</th>
                <th>Until</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  {editing?.id === c.id ? (
                    <>
                      <td>
                        <input className="input" value={editing.name} disabled={c.corporate} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Client name" />
                      </td>
                      <td>
                        <input className="input" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} aria-label="Client phone" />
                      </td>
                      <td colSpan={2} />
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(async () => { await api.put(`/staff-clients/${c.id}`, { name: editing.name, phone: editing.phone }); setEditing(null); return 'Saved.'; })}>Save</button>{' '}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <b>{c.name}</b>
                        {c.corporate && <span className="tag tag-outline" style={{ marginLeft: 6 }}>corporate</span>}
                      </td>
                      <td>{c.phone || '—'}</td>
                      <td className="text-muted">{fmtDate(c.startDate)}</td>
                      <td className="text-muted">{fmtDate(c.endDate)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ id: c.id, name: c.name, phone: c.phone })}>Edit</button>
                        {canRelease && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title="Let this client go, so another sales person can have them" onClick={() => run(async () => { await api.post(`/commission/clients/${c.id}/release`, {}); return `${c.name} released.`; })}>
                            Release
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note" style={{ margin: 0 }}>
          A client stays credited to their sales person for the months set in Commission → Rates, counted from their last order. A client who is already credited to someone else cannot be added until they are released.
        </p>
      </div>
    </div>
  );
}
