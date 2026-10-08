import { useState } from 'react';
import { isWeakPin } from '@glm/shared';
import { api } from '../api/client';

// Master Data → Staff & Users → Reset PIN. Give a person a new PIN: type one here (checked before anything changes), or leave it blank to have one made; email it
// to them, or take it from the screen and hand it over; and choose whether they must pick their own at next sign-in. Their open sessions end and any lockout clears.

interface Props {
  person: { id: number; name: string; email: string | null; role: string };
  /** The shortest PIN their role allows (6 for Admin and the roles that handle money). */
  needs: number;
  onClose: () => void;
  onDone: (message: string) => void;
}

export default function ResetPinDialog({ person, needs, onClose, onDone }: Props) {
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState(!!person.email);
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<string | null>(null); // a PIN that was made and is shown once

  async function reset() {
    setErr('');
    if (pin) {
      if (!/^\d+$/.test(pin) || pin.length < needs || pin.length > 6) return setErr(`A PIN of ${needs === 6 ? '6 digits' : '4 to 6 digits'} is needed for the ${person.role} role.`);
      if (isWeakPin(pin)) return setErr('That PIN is too easy to guess (like 1234 or 0000). Choose a less obvious one.');
    }
    setBusy(true);
    try {
      const r = await api.post<{ emailed: boolean; sentTo?: string; pin?: string }>(`/master-data/staff/${person.id}/reset-pin`, { pin, email: email && !!person.email, mustChange });
      if (r.pin) return setMade(r.pin); // made and not emailed: shown once, below
      onDone(r.emailed ? `${person.name}'s PIN was reset and emailed to ${r.sentTo}. If it does not arrive, ask them to check spam / junk and confirm the address.` : `${person.name}'s PIN was reset to the one you typed.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reset the PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={made ? undefined : onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">Reset PIN — {person.name}</div>
        {made ? (
          <>
            <div className="dialog-body">
              <p style={{ marginTop: 0 }}>The new PIN for <b>{person.name}</b> is:</p>
              <p style={{ fontFamily: 'var(--font-heading)', fontSize: 34, letterSpacing: '0.3em', margin: 'var(--space-2) 0' }}>{made}</p>
              <p className="note">Give it to them now. It is not shown again.{mustChange ? ' They will be asked to choose their own PIN when they sign in.' : ''}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={() => onDone(`${person.name}'s PIN was reset.`)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-body">
              <p className="note" style={{ marginTop: 0 }}>Their old PIN stops working at once and they are signed out. Any lockout is cleared.</p>
              <div className="field">
                <label>New PIN {needs === 6 ? '(6 digits)' : '(4–6 digits)'} — optional</label>
                <input className="input" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="leave blank to have one made for them" autoFocus autoComplete="off" />
              </div>
              <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: 400 }}>
                <input type="checkbox" checked={email && !!person.email} disabled={!person.email} onChange={(e) => setEmail(e.target.checked)} />
                {person.email ? `Email the PIN to ${person.email}` : 'Email the PIN (add their email address first)'}
              </label>
              <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: 400, marginTop: 'var(--space-2)' }}>
                <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
                Make them choose their own PIN at next sign-in
              </label>
              {!pin && !(email && !!person.email) && <p className="note">With no PIN typed and no email, the made PIN is shown here once for you to hand over.</p>}
              {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={reset} disabled={busy}>
                {busy ? 'Resetting…' : 'Reset PIN'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
