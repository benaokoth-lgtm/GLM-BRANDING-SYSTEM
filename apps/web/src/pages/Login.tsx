import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { useBranding } from '../hooks/useBranding';

interface SelectableUser {
  id: number;
  name: string;
  role: string;
  initials: string;
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '<'];

export default function Login() {
  const { login, loginError, user } = useAuth();
  const branding = useBranding();
  const navigate = useNavigate();
  const [users, setUsers] = useState<SelectableUser[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    api.get<SelectableUser[]>('/auth/users').then(setUsers).catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (pin.length === 4 && selectedId && !submitting) {
      setSubmitting(true);
      login(selectedId, pin).then((ok) => {
        setSubmitting(false);
        if (!ok) {
          setShake(true);
          setPin('');
          setTimeout(() => setShake(false), 300);
        }
      });
    }
  }, [pin, selectedId, login, submitting]);

  function pressKey(key: string) {
    if (submitting) return;
    if (key === 'C') return setPin('');
    if (key === '<') return setPin((p) => p.slice(0, -1));
    setPin((p) => (p.length < 4 ? p + key : p));
  }

  function selectUser(id: number) {
    setSelectedId(id);
    setPin('');
  }

  if (forgot) return <ForgotPin onDone={() => setForgot(false)} />;

  return (
    <div className="login-shell">
      <div className="login-card card blueprint elev-md">
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>

        <div className="login-users">
          {branding?.logoDataUrl && <img src={branding.logoDataUrl} alt={branding.companyName} style={{ maxHeight: 72, maxWidth: 220, objectFit: 'contain', alignSelf: 'flex-start', marginBottom: 'var(--space-2)' }} />}
          <div className="card-kicker">{branding?.systemName ?? ''}</div>
          <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
            Who's working?
          </div>
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              className={'login-user-btn' + (selectedId === u.id ? ' selected' : '')}
              onClick={() => selectUser(u.id)}
            >
              <span className="login-user-avatar">{u.initials}</span>
              <span>
                <div>{u.name}</div>
                <div className="text-muted" style={{ fontSize: 12 }}>
                  {u.role}
                </div>
              </span>
            </button>
          ))}
        </div>

        <div>
          <div className={'login-pin-dots' + (shake ? ' shake' : '')}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={'login-pin-dot' + (i < pin.length ? ' filled' : '')} />
            ))}
          </div>
          <div className="login-error">{loginError || (!selectedId ? 'Select your name' : ' ')}</div>
          <div className="login-pad">
            {PAD_KEYS.map((key) => (
              <button key={key} type="button" onClick={() => pressKey(key)} disabled={!selectedId || submitting}>
                {key}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginTop: 'var(--space-3)', width: '100%' }}
            onClick={() => setForgot(true)}
          >
            Admin: forgot PIN?
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin-only emailed reset: enter the recovery email → get a 6-digit code →
// enter it with a new 4-digit PIN. The server replies identically whether or
// not the email matches an Admin, so this can't be used to probe accounts.
function ForgotPin({ onDone }: { onDone: () => void }) {
  const branding = useBranding();
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      await api.post('/auth/forgot-pin', { email });
      setStep('code');
    });

  const reset = () =>
    run(async () => {
      await api.post('/auth/reset-pin', { email, code, newPin });
      setStep('done');
    });

  return (
    <div className="login-shell">
      <div className="login-card card blueprint elev-md" style={{ display: 'block', maxWidth: 420 }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">{branding?.systemName ?? ''}</div>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Reset Admin PIN
        </div>

        {step === 'email' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <p className="text-muted" style={{ fontSize: 13 }}>
              Enter the Admin's recovery email. We'll send a 6-digit code.
            </p>
            <input
              className="input"
              type="email"
              autoFocus
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%' }}
            />
            <div className="login-error">{error}</div>
            <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reset();
            }}
          >
            <p className="text-muted" style={{ fontSize: 13 }}>
              If that email belongs to an Admin, a code is on its way (valid 15 minutes). Enter it with a new 4-digit PIN.
            </p>
            <input
              className="input"
              inputMode="numeric"
              autoFocus
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', marginBottom: 'var(--space-2)' }}
            />
            <input
              className="input"
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="New 4-digit PIN"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%' }}
            />
            <div className="login-error">{error}</div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || code.length !== 6 || newPin.length !== 4}
              style={{ width: '100%' }}
            >
              {busy ? 'Saving…' : 'Set new PIN'}
            </button>
          </form>
        )}

        {step === 'done' && (
          <>
            <p>Your PIN has been changed. You can log in with it now.</p>
            <button type="button" className="btn btn-primary" onClick={onDone} style={{ width: '100%' }}>
              Back to login
            </button>
          </>
        )}

        {step !== 'done' && (
          <button type="button" className="btn btn-ghost" onClick={onDone} style={{ width: '100%', marginTop: 'var(--space-2)' }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
