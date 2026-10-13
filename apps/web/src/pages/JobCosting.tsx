import { useEffect, useMemo, useState } from 'react';
import { CARD_FINISH_LABEL, COSTING_BASIS_LABEL, COSTING_JOB_LABEL, VAT_RATE, fmtKsh } from '@glm/shared';
import type { CardFinish, CostingBasis, CostingJobType, CostingKind } from '@glm/shared';
import { api } from '../api/client';
import { Loading, numStyle } from './accounting/shared';

// Sales → Job Costing. Staff pick a kind of job (business cards, indoor or outdoor signage), say how many and how big, and are given the price to quote: what the supplier rates
// add up to (the materials and services kept in Master Data → Costing Rates), plus the margin, plus VAT. The margin and the profit are shown only to people who may see costs
// (Finance, the General Manager, Admin) — the salesperson sees the cost lines and the price. The arithmetic is the server's, so every screen and every quote agrees.

interface Config {
  canSeeCosts: boolean;
  jobTypes: { key: CostingJobType; label: string; wastagePct: number; cardsPerSheet: number; spareSheets: number; marginPct?: number }[];
  rates: { id: number; kind: CostingKind; name: string; basis: CostingBasis; jobTypes: CostingJobType[]; onlyFor: '' | 'lam' | 'frost'; defaultOn: boolean; sortOrder: number; cost?: number }[];
}
interface Quote {
  canSeeCosts: boolean;
  qty: number;
  summary: string;
  price: number;
  vat: number;
  total: number;
  unitPrice: number;
  unitTotal: number;
  // people who may see costs
  lines?: { rateId: number; kind: CostingKind; name: string; note: string; amount: number }[];
  cost?: number;
  marginPct?: number;
  profit?: number;
  profitOnPricePct?: number;
  tiers: { qty: number; sheets?: number; cost?: number; price: number; total: number; each: number; eachTotal: number }[];
}

const pct = (n: number) => `${parseFloat(n.toFixed(1))}%`;
const FINISHES: CardFinish[] = ['plain', 'lam', 'frost'];

export default function JobCosting() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState('');
  const [type, setType] = useState<CostingJobType>('cards');
  // each kind of job keeps what was typed in while you look at another
  const [form, setForm] = useState<Record<CostingJobType, { qty: string; w: string; h: string; finish: CardFinish; margin: string }>>({
    cards: { qty: '500', w: '', h: '', finish: 'plain', margin: '' },
    indoor: { qty: '1', w: '1', h: '2', finish: 'plain', margin: '' },
    outdoor: { qty: '1', w: '3', h: '1', finish: 'plain', margin: '' },
  });
  const [switched, setSwitched] = useState<Record<CostingJobType, { on: number[]; off: number[] }>>({ cards: { on: [], off: [] }, indoor: { on: [], off: [] }, outdoor: { on: [], off: [] } });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Config>('/costing/config')
      .then(setConfig)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load the costing'));
  }, []);

  const f = form[type];
  const sw = switched[type];
  const typeRow = config?.jobTypes.find((t) => t.key === type);
  const sees = !!config?.canSeeCosts;
  const rates = useMemo(
    () => (config?.rates ?? []).filter((r) => r.jobTypes.includes(type) && (type !== 'cards' || !r.onlyFor || r.onlyFor === f.finish)).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [config, type, f.finish],
  );
  const ticked = (r: { id: number; defaultOn: boolean }) => sw.on.includes(r.id) || (r.defaultOn && !sw.off.includes(r.id));

  // the quote follows what is typed in (a moment after the last key)
  const body = {
    jobType: type,
    qty: Number(f.qty) || 0,
    ...(type === 'cards' ? { finish: f.finish } : { widthM: Number(f.w) || 0, heightM: Number(f.h) || 0 }),
    on: sw.on,
    off: sw.off,
    ...(sees && f.margin.trim() !== '' && Number.isFinite(Number(f.margin)) ? { marginPct: Number(f.margin) } : {}),
  };
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!config) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .post<Quote>('/costing/quote', JSON.parse(key))
        .then((q) => {
          if (live) {
            setQuote(q);
            setError('');
          }
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not work out the costing'));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, config]);

  if (!config) return <Loading loading={!loadError} error={loadError} />;

  const set = (patch: Partial<typeof f>) => setForm({ ...form, [type]: { ...f, ...patch } });
  const toggle = (r: { id: number; defaultOn: boolean }) => {
    const on = sw.on.filter((x) => x !== r.id);
    const off = sw.off.filter((x) => x !== r.id);
    const nowOn = !ticked(r);
    // a line ticked by default that is switched off is remembered as "off"; an optional one that is switched on, as "on"
    setSwitched({ ...switched, [type]: { on: nowOn && !r.defaultOn ? [...on, r.id] : on, off: !nowOn && r.defaultOn ? [...off, r.id] : off } });
  };

  const field = (label: string, value: string, onChange: (v: string) => void, unit: string) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <input className="input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="text-muted" style={{ fontSize: 11 }}>{unit}</div>
    </div>
  );
  const group = (kind: CostingKind, title: string) => {
    const mine = rates.filter((r) => r.kind === kind);
    if (!mine.length) return null;
    return (
      <div>
        <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>{title}</div>
        {mine.map((r) => (
          <label key={r.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', fontWeight: 400, margin: '4px 0' }}>
            <input type="checkbox" checked={ticked(r)} onChange={() => toggle(r)} />
            <span style={{ flex: 1 }}>
              {r.name}
              {!r.defaultOn && <span className="text-muted"> · optional extra</span>}
            </span>
            {r.cost != null && <span className="text-muted" style={{ fontSize: 12 }}>{fmtKsh(r.cost)} {COSTING_BASIS_LABEL[r.basis]}</span>}
          </label>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="no-print">
        <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>Sales</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 38, lineHeight: 1.05, margin: 0 }}>Job costing</h1>
        <p className="note" style={{ marginBottom: 0 }}>
          Cost an outsourced branding job from the supplier rates and get the price to quote. Nothing here is saved or sent: it is a calculator.
        </p>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="tablist">
        {config.jobTypes.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={type === t.key} className={'btn ' + (type === t.key ? 'btn-primary' : 'btn-secondary')} onClick={() => setType(t.key)}>
            {COSTING_JOB_LABEL[t.key]}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div className="no-print" style={{ display: 'grid', gap: 'var(--space-5)' }}>
          {type === 'cards' && (
            <div>
              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>Finish</div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {FINISHES.map((x) => (
                  <button key={x} type="button" className={'btn btn-sm ' + (f.finish === x ? 'btn-primary' : 'btn-secondary')} aria-pressed={f.finish === x} onClick={() => set({ finish: x })}>
                    {CARD_FINISH_LABEL[x]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>{type === 'cards' ? 'The order' : 'Size & quantity'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3) var(--space-4)' }}>
              {field(type === 'cards' ? 'Cards required' : 'Quantity', f.qty, (v) => set({ qty: v }), type === 'cards' ? `cards · ${typeRow?.cardsPerSheet ?? 21} to an A3 sheet + ${typeRow?.spareSheets ?? 1} spare` : 'signs')}
              {type !== 'cards' && field('Width', f.w, (v) => set({ w: v }), 'm')}
              {type !== 'cards' && field('Height', f.h, (v) => set({ h: v }), 'm')}
              {type !== 'cards' && (
                <div className="text-muted" style={{ fontSize: 12, alignSelf: 'end' }}>
                  Material is costed with {typeRow?.wastagePct ?? 0}% wastage.
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <div className="card-kicker" style={{ marginBottom: -8 }}>What goes into the cost</div>
            {group('material', 'Materials')}
            {group('service', 'Services')}
            <p className="note" style={{ margin: 0 }}>Untick a line this job does not need; tick an optional extra it does. The rates themselves are kept in Master Data → Costing Rates.</p>
          </div>
          {sees && (
            <div className="field" style={{ margin: 0, maxWidth: 220 }}>
              <label>Margin (% on cost)</label>
              <input className="input" inputMode="decimal" value={f.margin} placeholder={String(typeRow?.marginPct ?? '')} onChange={(e) => set({ margin: e.target.value })} />
              <div className="text-muted" style={{ fontSize: 11 }}>Leave blank for this job's usual margin.</div>
            </div>
          )}
        </div>

        <div>
          <div className="card blueprint elev-md" style={{ position: 'sticky', top: 24 }}>
            <div style={{ padding: 'var(--space-5)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>Quote</div>
            {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
            {!quote ? (
              <p className="note">Working it out…</p>
            ) : (
              <>
                <p className="note" style={{ marginTop: 0 }}>{quote.summary}</p>
                {quote.lines && (
                  <div style={{ borderTop: '1px solid var(--color-divider)' }}>
                    {quote.lines.map((l) => (
                      <div key={l.rateId} style={{ display: 'flex', gap: 'var(--space-2)', padding: '7px 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 14 }}>
                        <span style={{ flex: 1 }}>
                          {l.name}
                          <div className="text-muted" style={{ fontSize: 11 }}>{l.note}</div>
                        </span>
                        <b style={numStyle}>{fmtKsh(l.amount)}</b>
                      </div>
                    ))}
                    {quote.lines.length === 0 && <p className="note">Nothing is ticked — there is no cost to add up.</p>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 2px', fontWeight: 700 }}>
                      <span>Production cost</span>
                      <span style={numStyle}>{fmtKsh(quote.cost ?? 0)}</span>
                    </div>
                    {quote.canSeeCosts && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 2px 8px' }}>
                      <span>Margin ({pct(quote.marginPct ?? 0)} on cost)</span>
                      <span style={numStyle}>{fmtKsh(quote.profit ?? 0)}</span>
                    </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)' }}>
                  <span>Price to quote (before VAT)</span>
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 30, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtKsh(quote.price)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <span className="text-muted">VAT {Math.round(VAT_RATE * 100)}%</span>
                  <span style={numStyle}>{fmtKsh(quote.vat)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, padding: '4px 0' }}>
                  <span>Customer pays (VAT included)</span>
                  <span style={numStyle}>{fmtKsh(quote.total)}</span>
                </div>
                {quote.qty > 0 && (
                  <div className="text-muted" style={{ textAlign: 'right', fontSize: 13 }}>
                    {fmtKsh(quote.unitPrice)} before VAT · {fmtKsh(quote.unitTotal)} with VAT, {type === 'cards' ? 'per card' : 'per sign'}
                  </div>
                )}
                {quote.canSeeCosts && (
                  <div className="text-muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8 }}>
                    <span>Profit {fmtKsh(quote.profit ?? 0)}</span>
                    <span>Margin on the price {pct(quote.profitOnPricePct ?? 0)}</span>
                  </div>
                )}
                <button type="button" className="btn btn-secondary btn-sm no-print" style={{ marginTop: 'var(--space-3)' }} onClick={() => window.print()}>
                  Print this quote
                </button>
              </>
            )}
            </div>
          </div>

          {quote && type === 'cards' && quote.tiers.length > 0 && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>Price by quantity · {CARD_FINISH_LABEL[f.finish]}</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Cards</th>
                    <th style={numStyle}>A3 sheets</th>
                    <th style={numStyle}>Cost</th>
                    <th style={numStyle}>Price</th>
                    <th style={numStyle}>With VAT</th>
                    <th style={numStyle}>Each</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.tiers.map((t) => (
                    <tr key={t.qty}>
                      <td>{t.qty.toLocaleString()}</td>
                      <td style={numStyle}>{t.sheets}</td>
                      <td style={numStyle}>{fmtKsh(t.cost ?? 0)}</td>
                      <td style={numStyle}>{fmtKsh(t.price)}</td>
                      <td style={numStyle}>{fmtKsh(t.total)}</td>
                      <td style={numStyle}>{fmtKsh(t.each)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
