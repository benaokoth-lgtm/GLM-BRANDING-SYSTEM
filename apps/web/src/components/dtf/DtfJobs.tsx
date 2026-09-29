import { useState } from 'react';
import { fmtDate, fmtKsh, fmtNum, jobCalc, jobTotals, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, Corners, Field, num, right } from './shared';
import type { DtfTabProps } from './shared';
import DtfOrderDialog from './DtfOrderDialog';

export default function DtfJobs({ data, reload, setError }: DtfTabProps) {
  const { user } = useAuth();
  const { settings } = data;
  const isAdmin = user?.role === 'Admin';
  const open = data.rolls.filter((r) => r.status === 'open' && r.installedOn);
  const [f, setF] = useState({ roll: '', client: '', run: '', artworks: '', pieces: '', mult: '', disc: '' });
  const [busy, setBusy] = useState(false);
  const [showOrderDialog, setShowOrderDialog] = useState(false);

  const rollId = f.roll && open.some((r) => r.id === f.roll) ? f.roll : (open[0]?.id ?? '');
  const roll = open.find((r) => r.id === rollId);
  const run = num(f.run);
  const art = num(f.artworks);
  const pcs = num(f.pieces);
  const disc = num(f.disc);
  const c = jobCalc(settings, run, art, pcs, f.mult.trim() === '' ? null : num(f.mult), disc);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + run > rollLen;
  const canSave = !busy && !!rollId && run > 0 && Number.isInteger(art) && art > 0 && Number.isInteger(pcs) && pcs > 0 && c.multiplier > 0;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const lines: [string, string, string][] = [
    ['Base / artwork', `${fmtNum(run, 2)} m × ${settings.stdPricePerM} ÷ ${fmtNum(art)}`, fmtKsh(c.basePerArtwork)],
    ['Proposed', `× ${c.multiplier}`, fmtKsh(c.proposed)],
    ['Final / piece', `− ${fmtNum(disc, 2)}`, fmtKsh(c.finalPerPiece)],
    ['Pieces', '', fmtNum(pcs)],
  ];

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 300px', maxWidth: 420 }} className="no-print">
        <Card title="Price artwork job">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Field label="Roll">
              <select className="input" value={rollId} onChange={(e) => setF({ ...f, roll: e.target.value })}>
                {open.length === 0 && <option value="">No open rolls</option>}
                {open.map((r) => (
                  <option key={r.id} value={r.id}>{r.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Client">
              <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
            </Field>
            <Field label="Running metres">
              <input className="input" inputMode="decimal" value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} />
            </Field>
            <Field label="No. of artworks">
              <input className="input" inputMode="numeric" value={f.artworks} onChange={(e) => setF({ ...f, artworks: e.target.value })} />
            </Field>
            <Field label="Pieces">
              <input className="input" inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} />
            </Field>
            <Field label="Multiplier">
              <input className="input" inputMode="decimal" placeholder={String(settings.defaultMultiplier)} value={f.mult} onChange={(e) => setF({ ...f, mult: e.target.value })} />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Discount / piece (negative = price up)">
                <input className="input" inputMode="decimal" value={f.disc} onChange={(e) => setF({ ...f, disc: e.target.value })} />
              </Field>
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)' }}>
            {lines.map(([l, fm, v]) => (
              <div key={l} style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 13 }}>
                <span style={{ flex: 1 }}>{l}</span>
                <span className="text-muted">{fm}</span>
                <b style={{ minWidth: 84, ...right }}>{v}</b>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-3) var(--space-2)', background: 'var(--color-accent-100)', color: 'var(--color-accent-900)' }}>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, letterSpacing: '0.08em' }}>JOB TOTAL</span>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 26 }}>{fmtKsh(c.jobTotal)}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {c.belowBase && (
              <div className="note" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
                Below base cost — this job loses money on film.
              </div>
            )}
            {overRoll && (
              <div className="note">
                This would use more than the roll's {fmtNum(rollLen)} m ({fmtNum(used, 1)} m already used).
              </div>
            )}
            <button type="button" className="btn btn-primary blueprint" disabled={!canSave} onClick={() => setShowOrderDialog(true)}>
              <Corners />
              Record job
            </button>
          </div>
        </Card>
      </div>

      {showOrderDialog && (
        <DtfOrderDialog
          mode="job"
          postUrl="/dtf/jobs"
          basePayload={{
            rollId,
            jobOn: todayStr(),
            client: f.client,
            runningMetres: run,
            artworks: art,
            pieces: pcs,
            multiplier: f.mult.trim() === '' ? null : num(f.mult),
            discountPerPiece: disc,
          }}
          qty={pcs}
          unitPrice={c.finalPerPiece}
          client={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => {
            setShowOrderDialog(false);
            setF({ roll: rollId, client: '', run: '', artworks: '', pieces: '', mult: '', disc: '' });
            reload();
          }}
        />
      )}

      <div style={{ flex: '3 1 520px', minWidth: 0 }}>
        <Card title="Artwork jobs">
          {data.jobs.length === 0 ? (
            <p className="note">No jobs yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Date</th><th>Roll</th><th>Client</th>
                    <th style={right}>Run m</th><th style={right}>Artworks</th><th style={right}>Pcs</th>
                    <th style={right}>Base</th><th style={right}>×</th><th style={right}>Final/pc</th><th style={right}>Total</th>
                    <th></th>
                    {isAdmin && <th className="no-print"></th>}
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.map((x) => {
                    const t = jobTotals(settings, x);
                    return (
                      <tr key={x.id}>
                        <td className="text-muted">{fmtDate(x.jobOn)}</td>
                        <td>{x.rollId}</td>
                        <td>{x.client || '—'}</td>
                        <td style={right}>{fmtNum(x.runningMetres, 2)}</td>
                        <td style={right}>{x.artworks}</td>
                        <td style={right}>{x.pieces}</td>
                        <td style={right}>{fmtNum(t.basePerArtwork)}</td>
                        <td style={right}>{t.multiplier}</td>
                        <td style={right}>{fmtNum(t.finalPerPiece)}</td>
                        <td style={{ ...right, fontWeight: 700 }}>{fmtNum(t.jobTotal)}</td>
                        <td>{t.belowBase && <span className="tag tag-outline">Below base</span>}</td>
                        {isAdmin && (
                          <td className="no-print">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => window.confirm(`Delete this job (${x.rollId}, ${fmtNum(x.runningMetres, 2)} m)?`) && act(() => api.del(`/dtf/jobs/${x.id}`))}
                            >
                              Delete
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
