import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VAT_RATE, filmPremiumCommission, filmPremiumPerM, fmtKsh, fmtNum, saleCalc, todayStr } from '@glm/shared';
import type { Band } from '@glm/shared';
import { api } from '../api/client';
import DtfOrderDialog from '../components/dtf/DtfOrderDialog';
import type { DtfData } from '../components/dtf/shared';

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);

// Sibling to New Walk-in Order (General Order) for capturing a DTF transfer-
// film sale — a standalone page rather than a tab buried inside the DTF
// manager tracker, so Staff with just canAccessDtf can reach it directly.
// The actual roll-consumption record and Order are both created together
// once the popup's Print button is pressed (see DtfOrderDialog.tsx).
export default function NewFilmOrder() {
  const navigate = useNavigate();
  const [data, setData] = useState<DtfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ roll: '', client: '', metres: '', price: '' });
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [filmBands, setFilmBands] = useState<Band[] | null>(null);

  useEffect(() => {
    // The scheme staff are paid under, to show what a higher price is worth to them (nothing is blocked if it can't be read).
    api
      .get<{ filmBands: Band[] }>('/commission/settings')
      .then((c) => setFilmBands(c.filmBands))
      .catch(() => setFilmBands(null));
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
  const metres = num(f.metres);
  const c = saleCalc(settings, metres, f.price.trim() === '' ? null : num(f.price), 0);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + metres > rollLen;
  const canSave = metres > 0 && !!rollId && c.valid;

  return (
    <div className="card blueprint" style={{ maxWidth: 560 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">Film order</div>
      <div className="card-title">New film sale</div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
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
        {open.length === 0 && <p className="note">No open film roll — ask a manager to install one under DTF → Rolls before capturing a sale.</p>}
        <div className="field" style={{ margin: 0 }}>
          <label>Client (optional)</label>
          <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} placeholder="Walk-in (optional)" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Metres</label>
            <input className="input" inputMode="decimal" value={f.metres} onChange={(e) => setF({ ...f, metres: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Price / m</label>
            <input className="input" inputMode="decimal" placeholder={String(settings.stdPricePerM)} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          </div>
        </div>
        {!c.valid && (
          <p className="note" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
            Blocked — the price cannot be below {settings.minPricePerM} Ksh/m.
          </p>
        )}
        {c.valid && metres > 0 && filmBands && c.price > settings.minPricePerM && (
          <p className="note" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
            {fmtNum(filmPremiumPerM(c.price, settings.minPricePerM))} Ksh/m above the {settings.minPricePerM} base — worth about{' '}
            <b>{fmtKsh(filmPremiumCommission(metres, c.price, settings.minPricePerM, filmBands, VAT_RATE))}</b> commission to you, earned as the customer pays.
          </p>
        )}
        {overRoll && (
          <p className="note">
            This would use more than the roll's {fmtNum(rollLen)} m ({fmtNum(used, 1)} m already used).
          </p>
        )}
      </div>

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
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>Sale total: {fmtKsh(c.total)}</div>
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
          mode="sale"
          postUrl="/dtf/sales"
          basePayload={{ rollId, soldOn: todayStr(), client: f.client, metres, pricePerM: f.price.trim() === '' ? null : num(f.price) }}
          qty={metres}
          unitPrice={c.price}
          client={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => navigate('/orders/mine')}
        />
      )}
    </div>
  );
}
