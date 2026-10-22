import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { addDays, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';

// A banner above every screen for the people who close the day: days on which a till took cash and was not closed (yesterday first), and — for the people who approve — cash-ups waiting for approval.
// It looks again each time the person moves to another screen, and goes away once the days are closed.

interface Reminder {
  unclosed: { date: string; tillId: number; tillName: string; cash: number }[];
  awaiting: { date: string; tillId: number; tillName: string; submittedByName: string; variance: number }[];
}

const label = (d: string) => (d === addDays(todayStr(), -1) ? 'Yesterday' : new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' }));

export default function DayCloseReminder() {
  const { user } = useAuth();
  const p = user?.permissions;
  const may = user?.role === 'Admin' || !!p?.canManagePayments || !!p?.canAccessFinance;
  const approves = user?.role === 'Admin' || !!p?.canAccessFinance;
  const { pathname } = useLocation();
  const [r, setR] = useState<Reminder | null>(null);

  useEffect(() => {
    if (!may) return;
    let live = true;
    api.get<Reminder>('/day-close/reminder').then((x) => live && setR(x)).catch(() => live && setR(null));
    return () => {
      live = false;
    };
  }, [may, pathname]);

  if (!may || !r) return null;
  const unclosed = r.unclosed;
  const awaiting = approves ? r.awaiting : [];
  if (unclosed.length === 0 && awaiting.length === 0) return null;
  return (
    <div className="no-print" role="status" style={{ border: '1px solid var(--color-error)', borderLeft: '4px solid var(--color-error)', padding: 'var(--space-3) var(--space-4)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {unclosed.length > 0 && (
        <div>
          <b>{unclosed[0]!.date === addDays(todayStr(), -1) ? 'Yesterday was not closed.' : 'A day was not closed.'}</b> Cash came in but nobody counted the drawer:{' '}
          {unclosed.slice(0, 4).map((u, i) => (
            <span key={`${u.date}|${u.tillId}`}>
              {i > 0 && ' · '}
              <Link to={`/day-close?date=${u.date}&till=${u.tillId}`}>
                {label(u.date)}, {u.tillName} ({fmtKsh(u.cash)} cash)
              </Link>
            </span>
          ))}
          {unclosed.length > 4 && ` · and ${unclosed.length - 4} more`}
        </div>
      )}
      {awaiting.length > 0 && (
        <div>
          <b>{awaiting.length} cash-up{awaiting.length === 1 ? '' : 's'} waiting for approval:</b>{' '}
          {awaiting.slice(0, 4).map((u, i) => (
            <span key={`${u.date}|${u.tillId}`}>
              {i > 0 && ' · '}
              <Link to={`/day-close?date=${u.date}&till=${u.tillId}`}>
                {label(u.date)}, {u.tillName} (counted by {u.submittedByName})
              </Link>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
