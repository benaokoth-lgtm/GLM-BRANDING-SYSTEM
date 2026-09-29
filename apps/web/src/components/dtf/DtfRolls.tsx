import { useState } from 'react';
import { fmtDate, fmtKsh, fmtNum, summariseRoll, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Corners, Field, Spec, num } from './shared';
import type { DtfTabProps } from './shared';

interface Draft {
  id: string | null; // null ⇒ installing a new roll
  installedOn: string;
  filmCost: string;
  inkPowderCost: string;
}

export default function DtfRolls({ data, reload, setError }: DtfTabProps) {
  const { settings } = data;
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const rolls = data.rolls
    .map((r) => summariseRoll(settings, r, data.sales, data.jobs))
    .sort((a, b) => (a.roll.id < b.roll.id ? 1 : -1));
  const closing = rolls.find((r) => r.roll.id === closingId);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      setDraft(null);
      setClosingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (!draft) return;
    const body = { installedOn: draft.installedOn, filmCost: num(draft.filmCost), inkPowderCost: num(draft.inkPowderCost) };
    return run(() => (draft.id ? api.put(`/dtf/rolls/${draft.id}`, body) : api.post('/dtf/rolls', body)));
  }

  return (
    <>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary blueprint"
          onClick={() => setDraft({ id: null, installedOn: todayStr(), filmCost: '', inkPowderCost: '' })}
        >
          <Corners />+ Install new roll
        </button>
      </div>

      {rolls.length === 0 && <p className="note">No rolls yet — install your first roll.</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))', gap: 'var(--space-6)' }}>
        {rolls.map((r) => {
          const len = r.roll.rollLengthM || settings.rollLengthM;
          const pct = (m: number) => `${Math.min(100, (m / len) * 100)}%`;
          return (
            <Card key={r.roll.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                <div>
                  <div className="card-kicker">
                    Installed {fmtDate(r.roll.installedOn)} · {r.closed ? `Finished ${fmtDate(r.roll.finishedOn)}` : 'In use'}
                  </div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 28 }}>{r.roll.id}</div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end', alignContent: 'flex-start' }}>
                  <span className={`tag ${r.closed ? 'tag-neutral' : 'tag-accent'}`}>{r.closed ? 'Closed' : 'Open'}</span>
                  {r.overTolerance && <span className="tag tag-outline">Over tolerance</span>}
                </div>
              </div>

              <div style={{ display: 'flex', height: 28, border: '1px solid var(--color-divider)', margin: 'var(--space-3) 0 var(--space-2)' }}>
                <div style={{ width: pct(r.filmM), background: 'var(--color-accent)' }} />
                <div style={{ width: pct(r.artM), background: 'var(--color-accent-300)' }} />
                <div style={{ flex: 1, background: 'repeating-linear-gradient(45deg, transparent 0 5px, var(--color-divider) 5px 6px)' }} />
              </div>
              <div className="note" style={{ marginBottom: 'var(--space-3)' }}>
                Film {fmtNum(r.filmM, 1)} m · Artwork {fmtNum(r.artM, 1)} m · {r.closed ? 'Wasted' : 'Left'} {fmtNum(r.remainingM, 1)} m
                {r.usedM > len && ' · over roll length!'}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <Spec label="Roll cost" value={fmtKsh(r.rollCost)} />
                <Spec label="Revenue" value={fmtKsh(r.revenue)} />
                <Spec label={r.closed ? 'Profit' : 'Profit so far'} value={fmtKsh(r.profit)} />
                <Spec label="Film Ksh/m" value={r.filmRevPerM == null ? '—' : fmtKsh(r.filmRevPerM)} />
                <Spec label="Art Ksh/m" value={r.artRevPerM == null ? '—' : fmtKsh(r.artRevPerM)} />
                <Spec label="Wastage" value={r.closed ? `${fmtNum(r.wastagePct, 1)}% · ${fmtKsh(r.wastageKes)}` : '—'} />
              </div>

              <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
                {!r.closed && <span className="note" style={{ flex: 1 }}>Profit so far — wastage lands when closed.</span>}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDraft({ id: r.roll.id, installedOn: r.roll.installedOn ?? todayStr(), filmCost: String(r.roll.filmCost), inkPowderCost: String(r.roll.inkPowderCost) })}
                >
                  Edit costs
                </button>
                {!r.closed ? (
                  <button type="button" className="btn btn-secondary" onClick={() => setClosingId(r.roll.id)}>Close roll</button>
                ) : (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.post(`/dtf/rolls/${r.roll.id}/reopen`, {}))}>
                    Reopen
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {draft && (
        <div className="dialog-backdrop" onClick={() => setDraft(null)}>
          <div className="dialog blueprint" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <Corners />
            <div className="dialog-title">{draft.id ? `Edit ${draft.id}` : 'Install new roll'}</div>
            <Field label="Date installed">
              <input className="input" type="date" value={draft.installedOn} onChange={(e) => setDraft({ ...draft, installedOn: e.target.value })} />
            </Field>
            <Field label="Film cost (Ksh)">
              <input className="input" inputMode="decimal" value={draft.filmCost} onChange={(e) => setDraft({ ...draft, filmCost: e.target.value })} />
            </Field>
            <Field label="Ink / powder cost (Ksh)">
              <input className="input" inputMode="decimal" value={draft.inkPowderCost} onChange={(e) => setDraft({ ...draft, inkPowderCost: e.target.value })} />
            </Field>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn btn-primary blueprint" disabled={busy || !draft.installedOn} onClick={saveDraft}>
                <Corners />
                {draft.id ? 'Save' : 'Install roll'}
              </button>
            </div>
          </div>
        </div>
      )}

      {closing && (
        <div className="dialog-backdrop" onClick={() => setClosingId(null)}>
          <div className="dialog blueprint" onClick={(e) => e.stopPropagation()}>
            <Corners />
            <div className="dialog-title">Close {closing.roll.id}?</div>
            <div className="dialog-body">
              {fmtNum(closing.remainingM, 1)} m unused will be recorded as wastage (
              {fmtNum((closing.remainingM / (closing.roll.rollLengthM || settings.rollLengthM)) * 100, 1)}% ·{' '}
              {fmtKsh((closing.remainingM * closing.rollCost) / (closing.roll.rollLengthM || settings.rollLengthM))}). The roll will no longer
              appear when recording sales or jobs.
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setClosingId(null)}>Cancel</button>
              <button type="button" className="btn btn-primary blueprint" disabled={busy} onClick={() => run(() => api.post(`/dtf/rolls/${closing.roll.id}/close`, {}))}>
                <Corners />
                Close roll
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
