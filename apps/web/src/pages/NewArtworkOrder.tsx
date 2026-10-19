import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DTF_PRODUCT_LABEL, fmtNum, todayStr } from '@glm/shared';
import type { DtfProduct } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';
import { ArtworkListDialog, ArtworkListPanel, newRow } from '../components/dtf/ArtworkList';
import type { UiRow } from '../components/dtf/ArtworkList';
import type { DtfData } from '../components/dtf/shared';

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);

// DTF / UV DTF artwork order. The sales person arranges the artworks on the film, enters the length of film used, and lists them — client, an optional description, how many, the price
// of one artwork with the heat press included (components/dtf/ArtworkList.tsx). There is no recommended price: the prices entered are the prices. The film comes off the roll once, as the
// length entered; the sizes are kept for DTF → Film layout.
export default function NewArtworkOrder({ product = 'dtf' }: { product?: DtfProduct }) {
  const label = DTF_PRODUCT_LABEL[product];
  const navigate = useNavigate();
  const { materials } = useCatalog();
  const [data, setData] = useState<DtfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ roll: '', client: '', run: '' });
  const [showDialog, setShowDialog] = useState(false);
  const [rows, setRows] = useState<UiRow[]>(() => [newRow(), newRow(), newRow()]);

  useEffect(() => {
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
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + run > rollLen;
  const hasRows = rows.some((r) => num(r.qty) > 0);

  return (
    <div className="card blueprint" style={{ maxWidth: 1060 }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">{label} artwork order</div>
      <div className="card-title">New {label} artwork order</div>

      {error && (
        <p className="note" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
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
          <label>Length of film used (m)</label>
          <input className="input" inputMode="decimal" value={f.run} onChange={(e) => setF({ ...f, run: e.target.value.replace(/[^\d.]/g, '') })} aria-label="Length of film used in metres" />
          <p className="note" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            Measure it once the artworks are arranged on the film. It comes off the roll — film is tracked by the length used.
          </p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Client for rows with none (optional)</label>
          <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} placeholder="Walk-in (optional)" />
        </div>
      </div>

      <ArtworkListPanel product={product} materials={materials} rows={rows} onChange={setRows} run={run} defaultClient={f.client} />

      {open.length === 0 && <p className="note" style={{ marginTop: 'var(--space-3)' }}>No open {label} film roll — ask a manager to install one under DTF → {label} → Rolls before capturing an order.</p>}
      {overRoll && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          This would use more than the roll's {fmtNum(rollLen)} m ({fmtNum(used, 1)} m already used).
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-5)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-4)' }}>
        <button type="button" className="btn btn-primary blueprint" onClick={() => setShowDialog(true)} disabled={!rollId || !(run > 0) || !hasRows}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Continue
        </button>
      </div>

      {showDialog && <ArtworkListDialog product={product} materials={materials} rollId={rollId} jobOn={todayStr()} run={run} rows={rows} defaultClient={f.client} onClose={() => setShowDialog(false)} onDone={() => navigate('/orders/all')} />}
    </div>
  );
}
