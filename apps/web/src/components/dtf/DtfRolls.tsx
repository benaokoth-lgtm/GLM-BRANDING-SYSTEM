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
  /** Installing a new roll: open rolls that are physically finished, to terminate (balance written off as waste) as the new one goes in. */
  terminate: Record<string, boolean>;
  terminateNote: string;
}

interface Terminating {
  id: string;
  cutOff: string;
  note: string;
}

export default function DtfRolls({ data, reload, setError }: DtfTabProps) {
  const { settings } = data;
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [terminating, setTerminating] = useState<Terminating | null>(null);

  const rolls = data.rolls
    .map((r) => summariseRoll(settings, r, data.sales, data.jobs))
    .sort((a, b) => (a.roll.id < b.roll.id ? 1 : -1));
  const closing = rolls.find((r) => r.roll.id === closingId);
  const terminatingRoll = rolls.find((r) => r.roll.id === terminating?.id);
  const openRolls = rolls.filter((r) => r.started && !r.closed);
  const rollLen = (r: (typeof rolls)[number]) => r.roll.rollLengthM || settings.rollLengthM;
  const wasteKes = (r: (typeof rolls)[number]) => (r.remainingM * r.rollCost) / rollLen(r);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      setDraft(null);
      setClosingId(null);
      setTerminating(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (!draft) return;
    const body = { installedOn: draft.installedOn, filmCost: num(draft.filmCost), inkPowderCost: num(draft.inkPowderCost) };
    // rolls ticked as physically finished are terminated at the new roll's install date, in the same step
    const terminate = Object.entries(draft.terminate).filter(([, on]) => on).map(([rollId]) => ({ rollId, note: draft.terminateNote.trim() || 'Physically finished — replaced by a new roll' }));
    return run(() => (draft.id ? api.put(`/dtf/rolls/${draft.id}`, body) : api.post('/dtf/rolls', { ...body, ...(terminate.length ? { terminate } : {}) })));
  }

  return (
    <>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary blueprint"
          onClick={() => setDraft({ id: null, installedOn: todayStr(), filmCost: '', inkPowderCost: '', terminate: {}, terminateNote: '' })}
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
                  <span className={`tag ${r.closed ? 'tag-neutral' : 'tag-accent'}`}>{r.closed ? (r.terminated ? 'Terminated' : 'Closed') : 'Open'}</span>
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

              {r.terminated && (
                <p className="note" style={{ margin: '0 0 var(--space-3)' }}>
                  <b>Terminated {fmtDate(r.roll.finishedOn)}</b> — the roll was physically finished while the system still showed {fmtNum(r.wastageM, 1)} m, which was written off as waste{r.roll.closedByName ? ` by ${r.roll.closedByName}` : ''}. “{r.roll.closeNote}”
                </p>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <Spec label="Roll cost" value={fmtKsh(r.rollCost)} />
                <Spec label="Revenue" value={fmtKsh(r.revenue)} />
                <Spec label={r.closed ? 'Profit' : 'Profit so far'} value={fmtKsh(r.profit)} />
                <Spec label="Film Ksh/m" value={r.filmRevPerM == null ? '—' : fmtKsh(r.filmRevPerM)} />
                <Spec label="Art Ksh/m" value={r.artRevPerM == null ? '—' : fmtKsh(r.artRevPerM)} />
                <Spec label="Wastage" value={r.closed ? `${fmtNum(r.wastagePct, 1)}% · ${fmtKsh(r.wastageKes)}` : '—'} />
                <Spec label="Discounts given" value={r.discountGiven > 0 ? fmtKsh(r.discountGiven) : '—'} />
                <Spec label="Profit lost to discounts" value={r.profitLostPct == null || r.discountGiven === 0 ? '—' : `${fmtNum(r.profitLostPct, 1)}%`} />
                <Spec label="Pending approval" value={r.pendingJobs ? `${r.pendingJobs} job${r.pendingJobs === 1 ? '' : 's'}` : '—'} />
              </div>

              <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
                {!r.closed && <span className="note" style={{ flex: 1 }}>Profit so far — wastage lands when closed.</span>}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDraft({ id: r.roll.id, installedOn: r.roll.installedOn ?? todayStr(), filmCost: String(r.roll.filmCost), inkPowderCost: String(r.roll.inkPowderCost), terminate: {}, terminateNote: '' })}
                >
                  Edit costs
                </button>
                {!r.closed ? (
                  <>
                    <button type="button" className="btn btn-secondary" title="The roll is physically finished but the system still shows a balance: close it and write the balance off as waste" onClick={() => setTerminating({ id: r.roll.id, cutOff: todayStr(), note: '' })}>Terminate roll</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setClosingId(r.roll.id)}>Close roll</button>
                  </>
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
            {!draft.id && openRolls.length > 0 && (
              <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
                <div className="card-kicker">Rolls still open on the system</div>
                <p className="note" style={{ marginTop: 0 }}>
                  If one of these has physically run out, tick it: it is terminated on the install date and the balance the system still shows is written off as waste.
                </p>
                {openRolls.map((r) => (
                  <label key={r.roll.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', fontWeight: 400, margin: 'var(--space-1) 0' }}>
                    <input type="checkbox" style={{ marginTop: 3 }} checked={!!draft.terminate[r.roll.id]} onChange={(e) => setDraft({ ...draft, terminate: { ...draft.terminate, [r.roll.id]: e.target.checked } })} />
                    <span>
                      <b>{r.roll.id}</b> is finished — write off {fmtNum(r.remainingM, 1)} m as waste ({fmtKsh(wasteKes(r))})
                    </span>
                  </label>
                ))}
                {Object.values(draft.terminate).some(Boolean) && (
                  <Field label="Note (kept with the terminated roll)">
                    <input className="input" value={draft.terminateNote} onChange={(e) => setDraft({ ...draft, terminateNote: e.target.value })} placeholder="Physically finished — replaced by a new roll" />
                  </Field>
                )}
              </div>
            )}
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

      {terminating && terminatingRoll && (
        <div className="dialog-backdrop" onClick={() => setTerminating(null)}>
          <div className="dialog blueprint" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <Corners />
            <div className="dialog-title">Terminate {terminatingRoll.roll.id}?</div>
            <div className="dialog-body">
              Use this when the roll is <b>physically finished</b> but the system still shows <b>{fmtNum(terminatingRoll.remainingM, 1)} m</b>. At the cut-off date the roll is closed and that balance is written off as <b>waste</b> (
              {fmtNum((terminatingRoll.remainingM / rollLen(terminatingRoll)) * 100, 1)}% · {fmtKsh(wasteKes(terminatingRoll))}). It can then take no more sales or jobs. The reason is kept with the roll.
              {terminatingRoll.pendingJobs > 0 && (
                <p className="note" style={{ color: 'var(--color-error)' }}>This roll has {terminatingRoll.pendingJobs} artwork job{terminatingRoll.pendingJobs === 1 ? '' : 's'} waiting for price approval — decide {terminatingRoll.pendingJobs === 1 ? 'it' : 'them'} first.</p>
              )}
            </div>
            <Field label="Cut-off date">
              <input className="input" type="date" min={terminatingRoll.roll.installedOn ?? undefined} max={todayStr()} value={terminating.cutOff} onChange={(e) => setTerminating({ ...terminating, cutOff: e.target.value })} />
            </Field>
            <Field label="Reason">
              <input className="input" value={terminating.note} onChange={(e) => setTerminating({ ...terminating, note: e.target.value })} placeholder="e.g. Film ran out on the machine" autoFocus />
            </Field>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTerminating(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary blueprint"
                disabled={busy || !terminating.cutOff || terminating.note.trim().length < 3 || terminatingRoll.pendingJobs > 0}
                onClick={() => run(() => api.post(`/dtf/rolls/${terminating.id}/terminate`, { cutOff: terminating.cutOff, note: terminating.note.trim() }))}
              >
                <Corners />
                Terminate &amp; write off
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
