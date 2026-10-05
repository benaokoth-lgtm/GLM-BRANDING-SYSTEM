import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VAT_RATE, artworkPremiumCommission, fmtKsh, fmtNum, jobCalc, summariseRoll, todayStr } from '@glm/shared';
import { api } from '../api/client';
import DtfOrderDialog from '../components/dtf/DtfOrderDialog';
import type { DtfData } from '../components/dtf/shared';

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;

// Sibling to New Walk-in Order (General Order) / New Film Order — captures
// an artwork print job. Price per piece = floor + a fixed per-running-metre
// charge shared across however many pieces that metre covers (see jobCalc
// in packages/shared/src/dtf.ts) — no separate artwork count or width
// measurement, since a half-empty strip simply has fewer pieces to share
// the charge with. Same Print-time order + roll-consumption creation as the
// film sale flow (see DtfOrderDialog.tsx), just for DTF Printing instead of
// DTF Sheet.
export default function NewArtworkOrder() {
  const navigate = useNavigate();
  const [data, setData] = useState<DtfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ roll: '', client: '', run: '', pieces: '', price: '' });
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [artworkRate, setArtworkRate] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<{ artworkRatePct: number }>('/commission/settings')
      .then((c) => setArtworkRate(c.artworkRatePct))
      .catch(() => setArtworkRate(null));
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
  const pcs = num(f.pieces);
  const c = jobCalc(run, pcs, settings.fixedChargePerMetre, settings.minPricePerPiece);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + run > rollLen;
  // The system's price is the recommended one (blank = charge it). Charging MORE earns commission on the extra. Charging LESS — down to
  // the per-piece floor — is a discount: it needs a manager's approval before the job is paid for or produced, and no other discount applies.
  const system = c.finalPerPiece;
  const floor = settings.minPricePerPiece;
  const priceIn = f.price.trim() === '' ? null : num(f.price);
  const belowFloor = priceIn != null && pcs > 0 && priceIn < floor - 0.005;
  const chosen = priceIn != null && !belowFloor && Math.abs(priceIn - system) > 0.005 ? priceIn : system;
  const belowSystem = pcs > 0 && chosen < system - 0.005;
  const discountTotal = belowSystem ? Math.round((system - chosen) * pcs * 100) / 100 : 0;
  const jobTotal = Math.round(chosen * pcs * 100) / 100;
  const canSave = !!rollId && run > 0 && Number.isInteger(pcs) && pcs > 0 && !belowFloor;
  // What this discount does to the roll's profit (managers see roll costs; staff just see the discount).
  const impact =
    belowSystem && roll && data.canManage
      ? (() => {
          const hypothetical = { id: 'new', rollId, jobOn: todayStr(), client: '', runningMetres: run, pieces: pcs, fixedChargePerMetreAtJob: settings.fixedChargePerMetre, minPricePerPieceAtJob: settings.minPricePerPiece, chargedPerPiece: chosen, approvalStatus: 'Approved' as const };
          return { now: summariseRoll(settings, roll, data.sales, data.jobs), after: summariseRoll(settings, roll, data.sales, [...data.jobs, hypothetical]) };
        })()
      : null;

  const lines: [string, string, string][] = [
    ['Fixed charge', `${fmtKsh(settings.fixedChargePerMetre)}/m × ${fmtNum(run, 2)} m ÷ ${fmtNum(pcs)} pcs`, pcs > 0 ? fmtKsh((c.finalPerPiece - settings.minPricePerPiece)) : '—'],
    ['Recommended price / piece', `${fmtKsh(settings.minPricePerPiece)} floor + fixed charge`, fmtKsh(system)],
    ...(chosen > system + 0.005 ? ([['Price charged / piece', `${fmtKsh(chosen - system)} above recommended`, fmtKsh(chosen)]] as [string, string, string][]) : []),
    ...(belowSystem ? ([['Price charged / piece', `${fmtKsh(system - chosen)} below recommended — needs approval`, fmtKsh(chosen)]] as [string, string, string][]) : []),
  ];

  return (
    <div className="card blueprint" style={{ maxWidth: 560 }}>
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
          <label>Client (optional)</label>
          <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} placeholder="Walk-in (optional)" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Running metres</label>
          <input className="input" inputMode="decimal" value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            The actual length printed on film — must already cover every piece below (a transfer is single-use).
          </p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Pieces</label>
          <input className="input" inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} placeholder="e.g. 108" />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            More pieces sharing this run means a cheaper price each; fewer means a dearer one — it never drops below the floor.
          </p>
        </div>
      </div>

      <div className="field" style={{ marginTop: 'var(--space-3)' }}>
        <label>Price / piece (optional)</label>
        <input className="input" style={{ maxWidth: 200 }} inputMode="decimal" placeholder={pcs > 0 ? String(system) : 'recommended'} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
          Leave blank to charge the recommended price.{artworkRate != null && ' Charge more and you earn commission on the amount above it.'} Charge less (not under {fmtKsh(floor)}) and the job needs a manager’s approval first.
        </p>
        {belowFloor && <p className="note" style={{ color: '#a33', margin: 'var(--space-1) 0 0' }}>Blocked — the price cannot be below the minimum of {fmtKsh(floor)} a piece.</p>}
        {belowSystem && (
          <div className="note" style={{ margin: 'var(--space-1) 0 0', borderLeft: '2px solid #a33', paddingLeft: 'var(--space-2)' }}>
            <b>Discount: {fmtKsh(discountTotal)}</b> ({fmtNum(((system - chosen) / system) * 100, 1)}% below the recommended {fmtKsh(system)}). The lower price <i>is</i> the discount — no other discount applies. It goes to a manager for approval first;
            payment is taken and production starts once it is approved.{artworkRate != null && ' No commission premium is earned on it.'}
            {impact && (
              <div style={{ marginTop: 4 }}>
                Roll {rollId} profit so far {fmtKsh(impact.now.profit)} → <b>{fmtKsh(impact.after.profit)}</b> if approved; its discounts would then take{' '}
                <b>{impact.after.profitLostPct == null ? '—' : `${fmtNum(impact.after.profitLostPct, 1)}%`}</b> of the profit it would make at full prices.
              </div>
            )}
          </div>
        )}
        {!belowFloor && chosen > system + 0.005 && artworkRate != null && (
          <p className="note" style={{ margin: 'var(--space-1) 0 0', borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
            {fmtKsh(chosen - system)} above recommended on each piece — worth about <b>{fmtKsh(artworkPremiumCommission(pcs, chosen, system, artworkRate, VAT_RATE))}</b> commission to you, earned as the customer pays.
          </p>
        )}
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
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Job total: {fmtKsh(jobTotal)}</div>
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
            pieces: pcs,
            pricePerPiece: Math.abs(chosen - system) > 0.005 ? chosen : null,
          }}
          qty={pcs}
          needsApproval={belowSystem}
          unitPrice={chosen}
          client={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => navigate('/orders/all')}
        />
      )}
    </div>
  );
}
