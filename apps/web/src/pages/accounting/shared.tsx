import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';

/** Accounting figures: two decimals, negatives in brackets, nil as a dash. */
export function money(n: number | null | undefined): string {
  if (n == null || Math.abs(n) < 0.005) return '–';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
}

export function ymd(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

export interface Range {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  set: (from: string, to: string) => void;
}

export function useRange(): Range {
  const now = new Date();
  // The year so far — a month is too narrow a window to open on: earlier records looked missing.
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), 0, 1)));
  const [to, setTo] = useState(ymd(now));
  const set = useCallback((f: string, t: string) => {
    setFrom(f);
    setTo(t);
  }, []);
  return { from, to, setFrom, setTo, set };
}

const PRESETS: { label: string; range: () => [Date, Date] }[] = [
  { label: 'Today', range: () => [new Date(), new Date()] },
  {
    label: 'Last 7 days',
    range: () => {
      const from = new Date();
      from.setDate(from.getDate() - 6);
      return [from, new Date()];
    },
  },
  { label: 'This month', range: () => [new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date()] },
  {
    label: 'Last month',
    range: () => {
      const n = new Date();
      return [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 0)];
    },
  },
  { label: 'This year', range: () => [new Date(new Date().getFullYear(), 0, 1), new Date()] },
];

/** Pick any run of days: quick presets, or a from/to of your own. */
export function DateRangeBar({ range }: { range: Range }) {
  return (
    <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      {PRESETS.map((p) => {
        const [f, t] = p.range();
        const active = range.from === ymd(f) && range.to === ymd(t);
        return (
          <button key={p.label} type="button" className={'btn btn-sm ' + (active ? 'btn-primary' : 'btn-secondary')} onClick={() => range.set(ymd(f), ymd(t))}>
            {p.label}
          </button>
        );
      })}
      <span className="text-muted" style={{ fontSize: 12, marginLeft: 'var(--space-2)' }}>
        From
      </span>
      <input className="input" style={{ width: 'auto' }} type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && range.setFrom(e.target.value)} />
      <span className="text-muted" style={{ fontSize: 12 }}>
        to
      </span>
      <input className="input" style={{ width: 'auto' }} type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && range.setTo(e.target.value)} />
    </div>
  );
}

export function AsOfBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <span className="text-muted" style={{ fontSize: 12 }}>
        As at
      </span>
      <input className="input" style={{ width: 'auto' }} type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(ymd(new Date()))}>
        Today
      </button>
    </div>
  );
}

/** Loads `path` (skipped while null) and reloads when it changes or `reload()` is called. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (live) {
          setData(d);
          setError('');
        }
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function Notice({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  return (
    <p className="note" role={error ? 'alert' : 'status'} style={{ color: error ? '#a33' : 'var(--color-text)', fontWeight: 700, borderLeft: `3px solid ${error ? '#a33' : 'var(--color-accent)'}`, paddingLeft: 'var(--space-2)' }}>
      {error || message}
    </p>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'good' | 'bad' | 'neutral' }) {
  return <span className={tone === 'good' ? 'tag tag-accent' : tone === 'bad' ? 'tag tag-outline' : 'tag tag-neutral'} style={tone === 'bad' ? { borderColor: '#a33', color: '#a33' } : undefined}>{children}</span>;
}

/** The blueprint-framed card every report sits in. */
export function Card({ title, hint, actions, children }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      {(title || actions) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {hint && <div className="note">{hint}</div>}
          </div>
          {actions && <div className="no-print">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export const numStyle = { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };

export function Loading({ loading, error }: { loading: boolean; error: string }) {
  return (
    <>
      <Notice error={error} />
      {loading && <p className="note">Loading…</p>}
    </>
  );
}

export const printPage = () => window.print();
