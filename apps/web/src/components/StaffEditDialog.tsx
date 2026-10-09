import { useState } from 'react';
import { api } from '../api/client';
import type { Permissions } from '@glm/shared';

// Master Data → Staff & Users → Edit. One window for what is kept about a person: their name (first name and surname are compulsory), email address, role and — for a
// sales person — whether they take orders. Everything is checked first and saved together. Changing the role or order taking signs them out so their screens follow.

interface Props {
  person: { id: number; firstName: string; middleName: string; lastName: string; email: string | null; role: string; orderTakingOff: boolean };
  /** Is this the signed-in Admin? (Their own role is changed by another Admin.) */
  isSelf: boolean;
  roleNames: string[];
  /** What each role allows, to know whether order taking applies. */
  permissionsOf: (role: string) => Permissions | undefined;
  onClose: () => void;
  onDone: (message: string) => void;
}

export default function StaffEditDialog({ person, isSelf, roleNames, permissionsOf, onClose, onDone }: Props) {
  const [first, setFirst] = useState(person.firstName);
  const [middle, setMiddle] = useState(person.middleName);
  const [last, setLast] = useState(person.lastName);
  const [email, setEmail] = useState(person.email ?? '');
  const [role, setRole] = useState(person.role);
  const [takesOrders, setTakesOrders] = useState(!person.orderTakingOff);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // order taking is only a choice for a sales person (a role marked "can be assigned orders"); the front office always takes orders
  const perms = role === 'Admin' ? undefined : permissionsOf(role);
  const salesPerson = !!perms?.canBeAssignedOrders && !perms.canCaptureForOthers;
  const roleChanged = role !== person.role;
  const orderTakingChanged = salesPerson && takesOrders === person.orderTakingOff;

  async function save() {
    setErr('');
    if (!first.trim()) return setErr('First name is required');
    if (!last.trim()) return setErr('Surname is required');
    if (roleChanged && !window.confirm(`Change ${first.trim()}'s role from ${person.role} to ${role}? They are signed out straight away and sign in again with what ${role} allows.`)) return;
    setBusy(true);
    try {
      const r = await api.put<{ name: string; roleChanged: boolean; mustChangePin: boolean }>(`/master-data/staff/${person.id}`, {
        firstName: first,
        middleName: middle,
        lastName: last,
        email,
        ...(isSelf ? {} : { role }),
        ...(salesPerson ? { orderTaking: takesOrders } : {}),
      });
      const signedOut = r.roleChanged || orderTakingChanged;
      onDone(`${r.name} was updated${r.roleChanged ? ` and is now ${role}` : ''}${signedOut && !isSelf ? '. They sign in again to see the change' : ''}${r.mustChangePin && r.roleChanged ? ', and choose a longer PIN when they do' : ''}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the changes');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog blueprint"
        style={{ maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) save();
        }}
      >
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">Edit — {person.firstName} {person.lastName}</div>
        <div className="dialog-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
            <div className="field">
              <label>First name *</label>
              <input className="input" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Middle name</label>
              <input className="input" value={middle} onChange={(e) => setMiddle(e.target.value)} />
            </div>
            <div className="field">
              <label>Surname *</label>
              <input className="input" value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Email address (used to email them their login PIN)</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com — leave blank to remove" />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="input" value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value)}>
              {roleNames.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {isSelf && <p className="note" style={{ margin: '4px 0 0' }}>Another Admin changes your role.</p>}
            {roleChanged && <p className="note" style={{ margin: '4px 0 0' }}>Changing the role signs them out; they sign in again with what the new role allows.</p>}
          </div>
          {salesPerson && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
              <input type="checkbox" checked={takesOrders} onChange={(e) => setTakesOrders(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                Takes orders themselves <span className="text-muted">(switched off, the front office captures their orders; their production and quality-control duties are unaffected)</span>
              </span>
            </label>
          )}
          {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
