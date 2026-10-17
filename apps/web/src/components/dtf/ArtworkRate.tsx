import { useEffect, useState } from 'react';
import { fmtKsh, fmtNum, runningMetreCalc, usesSmallSharePrice } from '@glm/shared';
import type { DtfProduct, DtfSettings, PriceList } from '@glm/shared';
import ListSwitch from './ListSwitch';
import { api } from '../../api/client';
import { Card, num } from './shared';
import type { DtfTabProps } from './shared';

// The price per running metre of artwork, on its own: the one figure every artwork order is worked out from — (price per running metre × running metres) ÷ artworks, so the client bears
// the empty space on the film. A manager changes it here whenever it should move; it applies to new orders from that moment and jobs already recorded keep the price they were saved with.

interface Change {
  at: string;
  by: string;
  pricePerMetre: number;
  product: string;
}

/** The input and Save, small enough to sit on the artwork order screen too. */
export function ArtworkRateEditor({ product, current, onSaved, compact = false, list = 'glm' }: { product: DtfProduct; current: number; onSaved: () => void | Promise<void>; compact?: boolean; list?: PriceList }) {
  const [v, setV] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setV(String(current)), [current]);
  const price = num(v);
  const changed = price > 0 && Math.abs(price - current) > 0.004;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.put('/dtf/artwork-rate', { product, pricePerMetre: price, ...(list === 'freelancer' ? { priceList: 'freelancer' } : {}) });
      await onSaved();
      setMsg({ ok: true, text: `Saved. ${list === 'freelancer' ? 'Freelancer Sales artwork' : 'Artwork'} is now ${fmtKsh(price)} a running metre, from this moment.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save the price' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>{compact ? 'Price per running metre (Ksh)' : 'Price per running metre of artwork (Ksh)'}</label>
          <input className="input" style={{ maxWidth: compact ? 160 : 220, fontSize: compact ? undefined : 20 }} inputMode="decimal" value={v} onChange={(e) => { setV(e.target.value); setMsg(null); }} aria-label="Price per running metre" />
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !changed} onClick={save}>
          {busy ? 'Saving…' : 'Save price'}
        </button>
        {changed && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setV(String(current))}>
            Undo
          </button>
        )}
      </div>
      {msg && (
        <p className="note" style={{ margin: 'var(--space-2) 0 0', color: msg.ok ? undefined : 'var(--color-error)' }} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** DTF → Artwork price: set it, see what it makes for a run of film, and who changed it when. */
export default function ArtworkRate({ data, reload }: DtfTabProps) {
  // GLM Sales (the saved rate) or Freelancer Sales (the GLM rate less the default percentage, or a rate typed by hand here)
  const [list, setList] = useState<PriceList>('glm');
  const [fl, setFl] = useState<{ settings: DtfSettings; freelancerManual?: Record<string, boolean>; freelancerDiscountPct?: number } | null>(null);
  const loadFl = () => api.get<NonNullable<typeof fl>>(`/dtf/data?product=${data.product}&scope=order&priceList=freelancer`).then(setFl).catch(() => setFl(null));
  useEffect(() => {
    if (list === 'freelancer') void loadFl();
  }, [list, data.product]); // eslint-disable-line react-hooks/exhaustive-deps
  const settings = list === 'freelancer' && fl ? fl.settings : data.settings;
  const typedByHand = list === 'freelancer' && !!fl?.freelancerManual?.fixedChargePerMetre;
  const current = settings.fixedChargePerMetre;
  const [history, setHistory] = useState<Change[] | null>(null);
  const [run, setRun] = useState('0.53');
  const [pieces, setPieces] = useState('2');

  const loadHistory = () =>
    api
      .get<Change[]>(`/dtf/artwork-rate/history?product=${data.product}&priceList=${list}`)
      .then(setHistory)
      .catch(() => setHistory([]));
  useEffect(() => {
    void loadHistory();
  }, [data.product, list]); // eslint-disable-line react-hooks/exhaustive-deps

  const { smallShareBelow: lowest, smallSharePrice } = settings;
  const calc = runningMetreCalc(num(run), num(pieces), current, lowest, smallSharePrice);
  const smallShare = usesSmallSharePrice(num(run), num(pieces), current, lowest, smallSharePrice);
  const shown = num(run) > 0 && num(pieces) > 0;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 760 }}>
      <ListSwitch value={list} onChange={setList} />
      <Card title={`${data.product === 'uv' ? 'UV DTF' : 'DTF'} artwork — price per running metre${list === 'freelancer' ? ' (Freelancer Sales)' : ''}`}>
        <ArtworkRateEditor
          product={data.product}
          list={list}
          current={current}
          onSaved={async () => {
            await reload();
            if (list === 'freelancer') await loadFl();
            await loadHistory();
          }}
        />
        {list === 'freelancer' && (
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            {typedByHand ? 'This rate was typed by hand for Freelancer Sales.' : `This rate follows the GLM rate less ${fl?.freelancerDiscountPct ?? 0}% (Master Data → Freelancer Prices).`}{' '}
            {typedByHand && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.put(`/dtf/settings?priceList=freelancer&product=${data.product}`, { fixedChargePerMetre: null });
                  await loadFl();
                }}
              >
                Follow the percentage again
              </button>
            )}
          </p>
        )}
        <p className="note" style={{ marginTop: 'var(--space-3)' }}>
          Every artwork order is worked out from this: <b>(price per running metre × running metres) ÷ artworks</b>. The film is paid for whether or not the artworks fill its width, so the
          client bears the empty space, and nothing else is added per piece. Change it whenever you need to — it applies to new orders from the moment you save, and jobs already recorded keep the
          price they were saved with. A price charged below the recommended one still waits for a manager’s approval.
        </p>
      </Card>

      <Card title="Try it on a run of film">
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Running metres</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={run} onChange={(e) => setRun(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Artworks on it</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="numeric" value={pieces} onChange={(e) => setPieces(e.target.value)} />
          </div>
        </div>
        <p style={{ margin: 'var(--space-3) 0 0' }}>
          {shown ? (
            <>
              {fmtKsh(current)} × {fmtNum(num(run), 2)} m = <b>{fmtKsh(Math.round(current * num(run) * 100) / 100)}</b> for the film, shared by {fmtNum(num(pieces))} artworks = {smallShare ? <>{fmtKsh(Math.round((current * num(run) * 100) / num(pieces)) / 100)} each, which is under {fmtKsh(lowest)}, so the recommended price is </> : null}<b>{fmtKsh(calc.finalPerPiece)} each</b>.
            </>
          ) : (
            <span className="note">Enter the metres and the number of artworks.</span>
          )}
        </p>
      </Card>

      <Card title="Recent changes">
        {history === null ? (
          <p className="note">Loading…</p>
        ) : history.length === 0 ? (
          <p className="note">No change has been made from here yet.</p>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Set by</th>
                <th style={{ textAlign: 'right' }}>Price per metre</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.at + h.pricePerMetre}>
                  <td>{new Date(h.at).toLocaleString()}</td>
                  <td>{h.by}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(h.pricePerMetre)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

