import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DTF_PRODUCT_LABEL, VAT_RATE, artworkPremiumCommission, fmtKsh, fmtNum, lowestArtworkPrice, runningMetreCalc, usesSmallSharePrice, chargeToSnapshot, sheetCalc, summariseRoll, todayStr } from '@glm/shared';
import type { DtfProduct } from '@glm/shared';
import { api } from '../api/client';
import DtfOrderDialog from '../components/dtf/DtfOrderDialog';
import { ArtworkSheetDialog, ArtworkSheetPanel, newSheetRow, toSheetRows } from '../components/dtf/ArtworkSheet';
import type { UiRow } from '../components/dtf/ArtworkSheet';
import type { DtfData } from '../components/dtf/shared';
import { ArtworkRateEditor } from '../components/dtf/ArtworkRate';

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
export default function NewArtworkOrder({ product = 'dtf' }: { product?: DtfProduct }) {
  const label = DTF_PRODUCT_LABEL[product];
  const navigate = useNavigate();
  const [data, setData] = useState<DtfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ roll: '', client: '', run: '', pieces: '', price: '' });
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [artworkRate, setArtworkRate] = useState<number | null>(null);
  // Artworks of different sizes (and perhaps different clients) on this length: priced row by row instead of one price for every piece
  const [sheetOn, setSheetOn] = useState(false);
  const [sheetRows, setSheetRows] = useState<UiRow[]>(() => [newSheetRow(), newSheetRow()]);

  const reloadData = () => api.get<DtfData>(`/dtf/data?product=${product}&scope=order`).then(setData);
  useEffect(() => {
    api
      .get<{ artworkRatePct: number }>('/commission/settings')
      .then((c) => setArtworkRate(c.artworkRatePct))
      .catch(() => setArtworkRate(null));
    api
      .get<DtfData>(`/dtf/data?product=${product}&scope=order`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load DTF data'));
  }, [product]);

  if (!data) return <p className="note">{error ?? 'Loading…'}</p>;

  const { settings } = data;
  const open = data.rolls.filter((r) => r.status === 'open' && r.installedOn);
  const rollId = f.roll && open.some((r) => r.id === f.roll) ? f.roll : (open[0]?.id ?? '');
  const roll = open.find((r) => r.id === rollId);
  const run = num(f.run);
  const pcs = num(f.pieces);
  const c = runningMetreCalc(run, pcs, settings.fixedChargePerMetre, settings.smallShareBelow, settings.smallSharePrice);
  const smallShare = usesSmallSharePrice(run, pcs, settings.fixedChargePerMetre, settings.smallShareBelow, settings.smallSharePrice);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + run > rollLen;
  // The system's price is the recommended one (blank = charge it). Charging MORE earns commission on the extra. Charging LESS — down to
  // the per-piece floor — is a discount: it needs a manager's approval before the job is paid for or produced, and no other discount applies.
  const system = c.finalPerPiece;
  const floor = lowestArtworkPrice(settings.minPricePerPiece, system);
  const priceIn = f.price.trim() === '' ? null : num(f.price);
  const belowFloor = priceIn != null && pcs > 0 && priceIn < Math.max(floor, 0.01) - 0.005; // a price of nothing is never allowed, with or without a minimum
  const chosen = priceIn != null && !belowFloor && Math.abs(priceIn - system) > 0.005 ? priceIn : system;
  const belowSystem = pcs > 0 && chosen < system - 0.005;
  const discountTotal = belowSystem ? Math.round((system - chosen) * pcs * 100) / 100 : 0;
  const jobTotal = Math.round(chosen * pcs * 100) / 100;
  const sheet = sheetCalc(toSheetRows(sheetRows), run, settings.fixedChargePerMetre, settings.minPricePerPiece, f.client, '', pcs, settings.smallSharePrice, settings.smallShareBelow);
  const canSave = !!rollId && run > 0 && Number.isInteger(pcs) && pcs > 0 && !belowFloor;
  // What this discount does to the roll's profit (managers see roll costs; staff just see the discount).
  const impact =
    belowSystem && roll && data.canManage
      ? (() => {
          const hypothetical = { id: 'new', rollId, jobOn: todayStr(), client: '', runningMetres: run, pieces: pcs, fixedChargePerMetreAtJob: chargeToSnapshot(run, c, settings.fixedChargePerMetre, smallShare), minPricePerPieceAtJob: 0, chargedPerPiece: chosen, approvalStatus: 'Approved' as const };
          return { now: summariseRoll(settings, roll, data.sales, data.jobs), after: summariseRoll(settings, roll, data.sales, [...data.jobs, hypothetical]) };
        })()
      : null;

  const lines: [string, string, string][] = [
    ['Film for this length', `${fmtKsh(settings.fixedChargePerMetre)}/m × ${fmtNum(run, 2)} m — the empty space is paid for too`, run > 0 ? fmtKsh(Math.round(settings.fixedChargePerMetre * run * 100) / 100) : '—'],
    ['Each artwork\'s share', `÷ ${fmtNum(pcs)} artworks`, pcs > 0 && run > 0 ? fmtKsh(Math.round(((settings.fixedChargePerMetre * run) / pcs) * 100) / 100) : '—'],
    ['Recommended price / piece', smallShare ? `the share is under ${fmtKsh(settings.smallShareBelow)}, so ${fmtKsh(settings.smallSharePrice)}` : 'each artwork\'s share of the film', fmtKsh(system)],
    ...(chosen > system + 0.005 ? ([['Price charged / piece', `${fmtKsh(chosen - system)} above recommended`, fmtKsh(chosen)]] as [string, string, string][]) : []),
    ...(belowSystem ? ([['Price charged / piece', `${fmtKsh(system - chosen)} below recommended — needs approval`, fmtKsh(chosen)]] as [string, string, string][]) : []),
  ];

  return (
    <div className="card blueprint" style={{ maxWidth: 560 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">{label} artwork order</div>
      <div className="card-title">New {label} artwork job</div>

      {error && (
        <p className="note" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}

      {data.canManage && (
        <details style={{ marginTop: 'var(--space-3)' }}>
          <summary style={{ cursor: 'pointer' }}>
            Price per running metre: <b>{fmtKsh(settings.fixedChargePerMetre)}</b> — change
          </summary>
          <div style={{ marginTop: 'var(--space-2)' }}>
            <ArtworkRateEditor product={product} current={settings.fixedChargePerMetre} onSaved={reloadData} compact />
          </div>
        </details>
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
          <label>{sheetOn ? 'Artworks on this length (all sizes, all clients)' : 'Pieces'}</label>
          <input className="input" inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} placeholder="e.g. 108" />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            {sheetOn ? 'With the running metres this gives the recommended price below; then share them into rows by size.' : 'The film for the running metres is shared between the pieces: more pieces on the run means a cheaper price each, fewer means a dearer one, because the empty space is paid for by the artworks.'}
          </p>
        </div>
      </div>

      <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 'var(--space-3)', fontWeight: 400 }}>
        <input type="checkbox" checked={sheetOn} onChange={(e) => setSheetOn(e.target.checked)} aria-label="Artworks of different sizes or for different clients" />
        <span>Artworks of different sizes, or for different clients — price each size</span>
      </label>
      {sheetOn && (
        <ArtworkSheetPanel rows={sheetRows} onChange={setSheetRows} run={run} fixedChargePerMetre={settings.fixedChargePerMetre} minPricePerPiece={settings.minPricePerPiece} smallSharePrice={settings.smallSharePrice} smallShareBelow={settings.smallShareBelow} defaultClient={f.client} artworkRate={artworkRate} pieces={pcs} />
      )}

      {!sheetOn && (
      <div className="field" style={{ marginTop: 'var(--space-3)' }}>
        <label>Price / piece (optional)</label>
        <input className="input" style={{ maxWidth: 200 }} inputMode="decimal" placeholder={pcs > 0 ? String(system) : 'recommended'} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
          Leave blank to charge the recommended price.{artworkRate != null && ' Charge more and you earn commission on the amount above it.'} Charge less{floor > 0 ? <> (not under {fmtKsh(floor)})</> : null} and the job needs a manager’s approval first.
        </p>
        {belowFloor && <p className="note" style={{ color: 'var(--color-error)', margin: 'var(--space-1) 0 0' }}>Blocked — the price cannot be below the minimum of {fmtKsh(floor)} a piece.</p>}
        {belowSystem && (
          <div className="note" style={{ margin: 'var(--space-1) 0 0', borderLeft: '2px solid var(--color-error)', paddingLeft: 'var(--space-2)' }}>
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
      )}

      {open.length === 0 && <p className="note" style={{ marginTop: 'var(--space-3)' }}>No open {label} film roll — ask a manager to install one under DTF → {label} → Rolls before capturing a job.</p>}

      <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)' }}>
        {(sheetOn ? lines.slice(0, 2) : lines).map(([l, fm, v]) => (
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
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Job total: {fmtKsh(sheetOn ? sheet.enteredTotal : jobTotal)}</div>
        <button type="button" className="btn btn-primary blueprint" onClick={() => setShowOrderDialog(true)} disabled={sheetOn ? !(sheet.ok && !!rollId && pcs > 0) : !canSave}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Continue
        </button>
      </div>

      {showOrderDialog && sheetOn && (
        <ArtworkSheetDialog
          product={product}
          rollId={rollId}
          jobOn={todayStr()}
          run={run}
          rows={sheetRows}
          pieces={pcs}
          fixedChargePerMetre={settings.fixedChargePerMetre}
          minPricePerPiece={settings.minPricePerPiece}
          smallSharePrice={settings.smallSharePrice}
          smallShareBelow={settings.smallShareBelow}
          defaultClient={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => navigate('/orders/all')}
        />
      )}
      {showOrderDialog && !sheetOn && (
        <DtfOrderDialog
          product={product}
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
