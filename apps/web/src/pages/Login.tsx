import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';

interface SelectableUser {
  id: number;
  name: string;
  role: string;
  initials: string;
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '<'];

export default function Login() {
  const { login, loginError, user } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<SelectableUser[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  return (
    <div className="login-shell">
      <div className="login-card card blueprint elev-md">
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>

        <div className="login-users">
          <div className="card-kicker">GLM Branding</div>
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
        </div>
      </div>
    </div>
  );
}
