import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeBillableMetres, computeFill, fmtKsh, fmtNum, jobCalc, todayStr } from '@glm/shared';
import { api } from '../api/client';
import DtfOrderDialog from '../components/dtf/DtfOrderDialog';
import type { DtfData } from '../components/dtf/shared';

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;

// Sibling to New Walk-in Order (General Order) / New Film Order — captures
// an artwork print job priced off running metres × multiplier, same
// Print-time order + roll-consumption creation as the film sale flow (see
// DtfOrderDialog.tsx), just for DTF Printing instead of DTF Sheet.
export default function NewArtworkOrder() {
  const navigate = useNavigate();
  const [data, setData] = useState<DtfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ roll: '', client: '', run: '', widthCm: '', pieces: '', mult: '', disc: '' });
  const [showOrderDialog, setShowOrderDialog] = useState(false);

  useEffect(() => {
    api
      .get<DtfData>('/dtf/data')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load DTF data'));
  }, []);

  if (!data) return <p className="note">{error ?? 'Loading…'}</p>;

  const { settings } = data;
  const open = data.rolls.filter((r) => r.status === 'open' && r.installedOn);
  const rollId = f.roll && open.some((r) => r.id === f.roll) ? f.roll : (open[0]?.id ?? '');
  const roll = open.find((r) => r.id === rollId);
  const run = num(f.run);
  const widthCm = f.widthCm.trim() === '' ? settings.rollWidthCm : num(f.widthCm);
  const pcs = num(f.pieces);
  const disc = num(f.disc);
  // A DTF transfer is single-use — one physical print per piece pressed —
  // so pieces and the film's cost-splitting "artworks" count are always the
  // same number here. Only one is ever asked for; see routes/dtf.ts.
  const fill = computeFill(widthCm, settings.rollWidthCm);
  const billableMetres = computeBillableMetres(settings, run, widthCm);
  const c = jobCalc(settings, billableMetres, pcs, pcs, f.mult.trim() === '' ? null : num(f.mult), disc);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + run > rollLen;
  const overWidth = widthCm > settings.rollWidthCm;
  const canSave = !!rollId && run > 0 && widthCm > 0 && !overWidth && Number.isInteger(pcs) && pcs > 0 && c.multiplier > 0;

  const lines: [string, string, string][] = [
    ['Fill', `${fmtNum(widthCm, 1)} cm of ${fmtNum(settings.rollWidthCm)} cm`, `${Math.round(fill * 100)}%`],
    ['Billable metres', `${fmtNum(run, 2)} m × (1 + ${settings.unfilledWidthPremium} × ${fmtNum(1 - fill, 2)})`, `${fmtNum(billableMetres, 2)} m`],
    ['Base / piece', `${fmtNum(billableMetres, 2)} m × ${settings.stdPricePerM} ÷ ${fmtNum(pcs)}`, fmtKsh(c.basePerArtwork)],
    ['Proposed', `× ${c.multiplier}`, fmtKsh(c.proposed)],
    ['Final / piece', `MAX(proposed, ${fmtKsh(settings.minPricePerPiece)}) − ${fmtNum(disc, 2)}`, fmtKsh(c.finalPerPiece)],
  ];

  return (
    <div className="card blueprint" style={{ maxWidth: 600 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Artwork order</div>
      <div className="card-title">New artwork job</div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Roll</label>
          <select className="input" value={rollId} onChange={(e) => setF({ ...f, roll: e.target.value })}>
            {open.length === 0 && <option value="">No open rolls</option>}
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Client</label>
          <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} placeholder="e.g. Peter Mwangi" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Running metres</label>
          <input className="input" inputMode="decimal" value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            The actual length printed on film — must already cover every piece below (a transfer is single-use).
          </p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Width used (cm)</label>
          <input className="input" inputMode="decimal" value={f.widthCm} onChange={(e) => setF({ ...f, widthCm: e.target.value })} placeholder={String(settings.rollWidthCm)} />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            Widest extent the artworks occupy across the {settings.rollWidthCm}cm roll — one eyeballed number, not per artwork.
          </p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Pieces</label>
          <input className="input" inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} placeholder="e.g. 3" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Multiplier</label>
          <input className="input" inputMode="decimal" placeholder={String(settings.defaultMultiplier)} value={f.mult} onChange={(e) => setF({ ...f, mult: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
          <label>Discount / piece (negative = price up)</label>
          <input className="input" inputMode="decimal" value={f.disc} onChange={(e) => setF({ ...f, disc: e.target.value })} />
        </div>
      </div>

      {open.length === 0 && <p className="note" style={{ marginTop: 'var(--space-3)' }}>No open film roll — ask a manager to install one under DTF → Rolls before capturing a job.</p>}

      <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)' }}>
        {lines.map(([l, fm, v]) => (
          <div key={l} style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 13 }}>
            <span style={{ flex: 1 }}>{l}</span>
            <span className="text-muted">{fm}</span>
            <b style={{ minWidth: 84, ...right }}>{v}</b>
          </div>
        ))}
      </div>

      {overWidth && (
        <p className="note" style={{ marginTop: 'var(--space-3)', borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
          Blocked — width used can't exceed the roll's {settings.rollWidthCm}cm width.
        </p>
      )}
      {c.belowBase && (
        <p className="note" style={{ marginTop: 'var(--space-3)', borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
          Below base cost — this job loses money on film.
        </p>
      )}
      {overRoll && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          This would use more than the roll's {fmtNum(rollLen)} m ({fmtNum(used, 1)} m already used).
        </p>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'var(--space-5)',
          borderTop: '1px solid var(--color-divider)',
          paddingTop: 'var(--space-4)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Job total: {fmtKsh(c.jobTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={() => setShowOrderDialog(true)} disabled={!canSave}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Continue
        </button>
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
            widthUsedCm: widthCm,
            pieces: pcs,
            multiplier: f.mult.trim() === '' ? null : num(f.mult),
            discountPerPiece: disc,
          }}
          qty={pcs}
          unitPrice={c.finalPerPiece}
          client={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => navigate('/orders/mine')}
        />
      )}
    </div>
  );
}
