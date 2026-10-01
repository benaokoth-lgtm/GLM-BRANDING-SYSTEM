import { useState } from 'react';
import { api } from '../api/client';

const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

export default function ChangePinDialog({ onClose }: { onClose: () => void }) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = confirmPin.length === 4 && confirmPin !== newPin;
  const canSave = currentPin.length === 4 && newPin.length === 4 && confirmPin === newPin && newPin !== currentPin;

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/change-pin', { currentPin, newPin });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">Change PIN</div>
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
                <input className="input" type="password" inputMode="numeric" autoComplete="current-password" autoFocus value={currentPin} onChange={(e) => setCurrentPin(digits(e.target.value))} placeholder="4 digits" />
              </div>
              <div className="field">
                <label>New PIN</label>
                <input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={newPin} onChange={(e) => setNewPin(digits(e.target.value))} placeholder="4 digits" />
              </div>
              <div className="field">
                <label>Confirm new PIN</label>
                <input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(digits(e.target.value))} placeholder="4 digits" />
              </div>
              {mismatch && <p className="note" style={{ color: '#a33' }}>The new PINs don't match.</p>}
              {newPin.length === 4 && newPin === currentPin && <p className="note" style={{ color: '#a33' }}>The new PIN must differ from the current one.</p>}
              {error && <p className="note" style={{ color: '#a33' }}>{error}</p>}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
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
