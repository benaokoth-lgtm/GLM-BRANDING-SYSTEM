import { useEffect, useState } from 'react';
import { FILM_ROLL_DEFAULT_COST, FILM_ROLL_DEFAULT_LENGTH_M, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { FilmRollRow, FilmUsageRow } from '../api/models';

type FilmTab = 'usage' | 'rolls';
type Preset = 'week' | 'month' | 'all';

function presetRange(preset: Preset, today: string): { from: string; to: string } {
  if (preset === 'all') return { from: '2020-01-01', to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() - 6);
  return { from: d.toISOString().slice(0, 10), to: today };
}

function fmtM(n: number): string {
  return `${(Math.round(n * 10) / 10).toLocaleString('en-KE')} m`;
}

export default function Film() {
  const today = todayStr();
  const [tab, setTab] = useState<FilmTab>('usage');
  const initial = presetRange('month', today);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);

  const [rolls, setRolls] = useState<FilmRollRow[]>([]);
  const [usages, setUsages] = useState<FilmUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newUsage, setNewUsage] = useState({ date: today, lengthM: '', ratePerMeter: '', note: '' });
  const [newRoll, setNewRoll] = useState({ lengthM: String(FILM_ROLL_DEFAULT_LENGTH_M), costTotal: String(FILM_ROLL_DEFAULT_COST), date: today });

  function load() {
    setLoading(true);
    Promise.all([api.get<FilmRollRow[]>('/film/rolls'), api.get<FilmUsageRow[]>(`/film/usage?from=${fromDate}&to=${toDate}`)])
      .then(([r, u]) => {
        setRolls(r);
        setUsages(u);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [fromDate, toDate]);

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  const activeRoll = rolls.find((r) => r.status === 'Active') ?? null;
  const finishedRolls = rolls.filter((r) => r.status === 'Finished');

  async function submitUsage() {
    const lengthM = Number(newUsage.lengthM);
    if (!lengthM || lengthM <= 0) return setError('Length fed must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/film/usage', {
        date: newUsage.date,
        lengthM,
        ratePerMeter: newUsage.ratePerMeter ? Number(newUsage.ratePerMeter) : undefined,
        note: newUsage.note,
      });
      setNewUsage((d) => ({ ...d, lengthM: '', ratePerMeter: '', note: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log film usage');
    } finally {
      setBusy(false);
    }
  }

  async function installRoll() {
    const lengthM = Number(newRoll.lengthM);
    const costTotal = Number(newRoll.costTotal);
    if (!lengthM || lengthM <= 0) return setError('Roll length must be greater than 0');
    if (!costTotal || costTotal <= 0) return setError('Roll cost must be greater than 0');
    setError(null);
    setBusy(true);
    try {
      await api.post('/film/rolls', { lengthM, costTotal, date: newRoll.date });
      setNewRoll({ lengthM: String(FILM_ROLL_DEFAULT_LENGTH_M), costTotal: String(FILM_ROLL_DEFAULT_COST), date: today });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install film roll');
    } finally {
      setBusy(false);
    }
  }

  const usedInRange = usages.reduce((a, u) => a + u.lengthM, 0);
  const revenueInRange = usages.reduce((a, u) => a + (u.revenue ?? 0), 0);
  const revenuePerMetre = usedInRange > 0 ? revenueInRange / usedInRange : 0;
  const wasteAllTime = finishedRolls.reduce((a, r) => a + r.wasteM, 0);

  if (loading && rolls.length === 0) return <p className="note">Loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(['usage', 'rolls'] as FilmTab[]).map((id) => (
          <button key={id} type="button" className={'btn blueprint ' + (tab === id ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab(id)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {id === 'usage' ? 'Film Usage' : 'Film Rolls'}
          </button>
        ))}
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      {tab === 'usage' && (
        <>
          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary" onClick={() => applyPreset('week')}>
                  Last 7 days
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => applyPreset('month')}>
                  This month
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => applyPreset('all')}>
                  All logged data
                </button>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label>From</label>
                  <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>To</label>
                  <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">DTF film used</div>
              <div className="card-title">{fmtM(usedInRange)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Revenue realized</div>
              <div className="card-title">{fmtKsh(revenueInRange)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Revenue per metre</div>
              <div className="card-title">{fmtKsh(revenuePerMetre)}</div>
            </div>
            <div className="card blueprint elev-sm">
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              <div className="card-kicker">Waste logged (all-time)</div>
              <div className="card-title">{fmtM(wasteAllTime)}</div>
            </div>
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Log film fed into the machine
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              For film consumed outside a captured order (test prints, jobs run off-system, corrections). Decrements
              the active roll the same way order-linked usage does.
              {activeRoll ? ` Active roll has ${fmtM(activeRoll.remainingM)} remaining.` : ' No active roll — install one under Film Rolls first.'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 1.4fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={newUsage.date} onChange={(e) => setNewUsage((d) => ({ ...d, date: e.target.value }))} />
              </div>
              <div className="field">
                <label>Length fed (m)</label>
                <input className="input" value={newUsage.lengthM} onChange={(e) => setNewUsage((d) => ({ ...d, lengthM: e.target.value }))} />
              </div>
              <div className="field">
                <label>Rate charged (Ksh/m)</label>
                <input className="input" value={newUsage.ratePerMeter} onChange={(e) => setNewUsage((d) => ({ ...d, ratePerMeter: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Note</label>
                <input className="input" value={newUsage.note} onChange={(e) => setNewUsage((d) => ({ ...d, note: e.target.value }))} placeholder="Optional" />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={submitUsage} disabled={busy || !activeRoll}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Log
              </button>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Usage log
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Order</th>
                  <th style={{ textAlign: 'right' }}>Length</th>
                  <th style={{ textAlign: 'right' }}>Rate/m</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th>Note</th>
                  <th>Captured by</th>
                </tr>
              </thead>
              <tbody>
                {usages.map((u) => (
                  <tr key={u.id}>
                    <td className="text-muted">{fmtDate(u.date)}</td>
                    <td>
                      <span className={u.source === 'Order' ? 'tag tag-accent' : 'tag tag-neutral'}>{u.source}</span>
                    </td>
                    <td className="text-muted">{u.orderNo ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtM(u.lengthM)}</td>
                    <td style={{ textAlign: 'right' }}>{u.ratePerMeter != null ? fmtKsh(u.ratePerMeter) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{u.revenue != null ? fmtKsh(u.revenue) : '—'}</td>
                    <td className="text-muted">{u.note}</td>
                    <td className="text-muted">{u.capturedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usages.length === 0 && <p className="note">No film usage logged in range.</p>}
          </div>
        </>
      )}

      {tab === 'rolls' && (
        <>
          <div className="card blueprint elev-sm" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-kicker">Active roll</div>
            {activeRoll ? (
              <>
                <div className="card-title">{fmtM(activeRoll.remainingM)} remaining of {fmtM(activeRoll.lengthM)}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                  <div>
                    <div className="text-muted" style={{ fontSize: 11 }}>Installed</div>
                    <div>{fmtDate(activeRoll.installedDate)} · {activeRoll.installedByName}</div>
                  </div>
                  <div>
                    <div className="text-muted" style={{ fontSize: 11 }}>Cost / metre</div>
                    <div>{fmtKsh(activeRoll.costPerMeter)}</div>
                  </div>
                  <div>
                    <div className="text-muted" style={{ fontSize: 11 }}>Avg rate charged so far</div>
                    <div>{activeRoll.avgRatePerMeter != null ? fmtKsh(activeRoll.avgRatePerMeter) : '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted" style={{ fontSize: 11 }}>Margin / metre so far</div>
                    <div>
                      {activeRoll.marginPerMeter != null ? (
                        <span className={activeRoll.undercharged ? 'tag tag-accent' : 'tag tag-neutral'}>{fmtKsh(activeRoll.marginPerMeter)}</span>
                      ) : (
                        '—'
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="note" style={{ margin: 0 }}>
                No film roll installed — install one below to start tracking usage.
              </p>
            )}
          </div>

          <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Install new roll
            </div>
            <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
              {activeRoll
                ? activeRoll.remainingM > 0.05
                  ? `This retires the current roll. It still shows ${fmtM(activeRoll.remainingM)} remaining — that shortfall will be logged as waste.`
                  : 'This retires the current roll (fully used, no waste to log).'
                : 'Starts a fresh roll for usage to draw against.'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Roll length (m)</label>
                <input className="input" value={newRoll.lengthM} onChange={(e) => setNewRoll((r) => ({ ...r, lengthM: e.target.value }))} />
              </div>
              <div className="field">
                <label>Cost (Ksh)</label>
                <input className="input" value={newRoll.costTotal} onChange={(e) => setNewRoll((r) => ({ ...r, costTotal: e.target.value }))} />
              </div>
              <div className="field">
                <label>Date installed</label>
                <input className="input" type="date" value={newRoll.date} onChange={(e) => setNewRoll((r) => ({ ...r, date: e.target.value }))} />
              </div>
              <button type="button" className="btn btn-primary blueprint" onClick={installRoll} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Install
              </button>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
              Roll history &amp; waste report
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Installed</th>
                  <th>Finished</th>
                  <th style={{ textAlign: 'right' }}>Length</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                  <th style={{ textAlign: 'right' }}>Cost/m</th>
                  <th style={{ textAlign: 'right' }}>Used</th>
                  <th style={{ textAlign: 'right' }}>Waste</th>
                  <th style={{ textAlign: 'right' }}>Avg rate charged</th>
                  <th style={{ textAlign: 'right' }}>Margin/m</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rolls.map((r) => (
                  <tr key={r.id}>
                    <td className="text-muted">{fmtDate(r.installedDate)}</td>
                    <td className="text-muted">{fmtDate(r.finishedDate)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtM(r.lengthM)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.costTotal)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtKsh(r.costPerMeter)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtM(r.usedM)}</td>
                    <td style={{ textAlign: 'right' }}>{r.status === 'Finished' ? fmtM(r.wasteM) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.avgRatePerMeter != null ? fmtKsh(r.avgRatePerMeter) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {r.marginPerMeter != null ? (
                        <span className={r.undercharged ? 'tag tag-accent' : 'tag tag-neutral'}>{fmtKsh(r.marginPerMeter)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <span className={r.status === 'Active' ? 'tag tag-accent' : 'tag tag-outline'}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rolls.length === 0 && <p className="note">No film rolls installed yet.</p>}
            <p className="note" style={{ marginTop: 'var(--space-2)' }}>
              A roll marked "undercharged" (orange margin) means the average rate actually charged for jobs cut from
              it was below what the roll itself cost per metre — worth revisiting DTF pricing.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
