import { useState } from 'react';
import { PIN_MAX, isWeakPin } from '@glm/shared';
import { api, setToken } from '../api/client';
import { useAuth } from '../state/AuthContext';

const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);

// `forced`: the person was emailed a PIN and must choose their own — the dialog can't be closed until they have.
export default function ChangePinDialog({ onClose, forced = false, onChanged }: { onClose: () => void; forced?: boolean; onChanged?: () => void }) {
  const { user } = useAuth();
  // The Admin, and anyone whose role handles money, costs, pay or the books, needs a 6-digit PIN; others at least 4.
  const need = user?.pinNeeds ?? 4;
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const weak = newPin.length >= need && isWeakPin(newPin);
  const mismatch = confirmPin.length >= need && confirmPin !== newPin;
  const canSave = currentPin.length >= 4 && newPin.length >= need && !weak && confirmPin === newPin && newPin !== currentPin;

  async function save() {
    setBusy(true);
    setError('');
    try {
      // Changing the PIN ends the person's other sessions; this one carries on with the fresh token the server hands back.
      const r = await api.post<{ token: string }>('/auth/change-pin', { currentPin, newPin });
      setToken(r.token);
      if (forced) {
        onChanged?.();
        window.location.reload(); // the screens behind were refused until now; load them again
      } else setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={forced ? undefined : onClose}>
      <div className="dialog blueprint" onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">{forced ? 'Choose your own PIN' : 'Change PIN'}</div>
        {forced && <p className="note" style={{ margin: 0 }}>Choose your own PIN before you carry on. Enter your current PIN (or the one that was emailed to you), then a new {need}-digit PIN that only you know — not an obvious one like 1234 or 0000.</p>}
        {done ? (
          <>
            <div className="dialog-body">
              <p>Your PIN has been changed. Use the new PIN next time you log in.</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave && !busy) save();
            }}
          >
            <div className="dialog-body">
              <div className="field">
                <label>Current PIN</label>
                <input className="input" type="password" inputMode="numeric" autoComplete="current-password" autoFocus value={currentPin} onChange={(e) => setCurrentPin(digits(e.target.value))} placeholder="current PIN" />
              </div>
              <div className="field">
                <label>New PIN</label>
                <input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={newPin} onChange={(e) => setNewPin(digits(e.target.value))} placeholder={need > 4 ? `${need} digits` : '4 to 6 digits'} />
              </div>
              <div className="field">
                <label>Confirm new PIN</label>
                <input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(digits(e.target.value))} placeholder="same again" />
              </div>
              {mismatch && <p className="note" style={{ color: 'var(--color-error)' }}>The new PINs don't match.</p>}
              {weak && <p className="note" style={{ color: 'var(--color-error)' }}>That PIN is too easy to guess (like 1234 or 0000). Choose a less obvious one.</p>}
              {newPin.length > 0 && newPin.length < need && <p className="note">Your PIN needs {need} digits{need > 4 ? ' for your role' : ' at least'}.</p>}
              {newPin.length >= need && newPin === currentPin && <p className="note" style={{ color: 'var(--color-error)' }}>The new PIN must differ from the current one.</p>}
              {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
            </div>
            <div className="dialog-actions">
              {!forced && (
                <button type="button" className="btn btn-secondary" onClick={onClose}>
                  Cancel
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={!canSave || busy}>
                {busy ? 'Saving…' : 'Change PIN'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
