import { useEffect, useMemo, useState } from 'react';
import { PRINT_FEE_LABELS, PRINT_PAGE_OPTIONS, PRINT_PRODUCTS, PRINT_PRODUCT_LABEL, PRINT_UPS, VAT_RATE, fmtKsh, fmtNum, printSettingsProblem } from '@glm/shared';
import type { PrintJob, PrintProduct, PrintSettings, PrintSize } from '@glm/shared';
import { api, downloadFile } from '../api/client';
import { numStyle } from '../pages/accounting/shared';
import StaffClientPicker from './StaffClientPicker';
import { useAuth } from '../state/AuthContext';

// Job Costing → Brochures & Eulogies: eulogy booklets, company profiles and brochures printed by a supplier. Pick the job and the quantity and the price to quote appears, VAT included,
// with the cost lines behind it; a price list for the usual quantities; and a client quote to print. The arithmetic is the server's (packages/shared/src/printCosting.ts), so every
// screen agrees. The cost lines are for everyone who costs a job; the mark-up (and the choice between a mark-up by quantity and a flat one) only for people who may see costs; the
// printer's rates are an Admin's to keep, under Rates.

interface Config {
  canSeeCosts: boolean;
  papers: string[];
  pageOptions: number[];
}
interface Result {
  canSeeCosts: boolean;
  spec: string;
  qty: number;
  sheets: number;
  lines: { label: string; note: string; amount: number }[];
  cost: number;
  priceExVat: number;
  vat: number;
  total: number;
  unitExVat: number;
  unitTotal: number;
  // people who may see costs
  markupPct?: number;
  markup?: number;
  profit?: number;
}
interface PriceList {
  bookletQtys: number[];
  brochureQtys: number[];
  booklets: { pages: number; sheets: number; cells: number[] }[];
  brochures: { name: string; ups: number; cells: number[] }[];
}
type View = 'calc' | 'list' | 'rates';

const f2 = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const label = { fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 } as const;

export default function PrintCosting({ onSaved }: { onSaved?: (quoteId: number) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('calc');
  const [job, setJob] = useState<{ product: PrintProduct; pages: number; paper: number; cover: number; coverSep: boolean; lam: boolean; fold: boolean; size: PrintSize; sides: 1 | 2; qty: string; mode: 'tier' | 'flat' }>({
    product: 'eulogy',
    pages: 8,
    paper: 0,
    cover: 4,
    coverSep: false,
    lam: false,
    fold: true,
    size: 'A4',
    sides: 2,
    qty: '100',
    mode: 'tier',
  });
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  // "Save as quote": keep this costing for a client, to agree the price and capture as an order
  const [saving, setSaving] = useState<{ client: string; phone: string; note: string; busy: boolean; err: string } | null>(null);

  useEffect(() => {
    api
      .get<Config>('/costing/print/config')
      .then((c) => {
        setConfig(c);
        // the second-to-last paper is not assumed: a separate cover starts on the last (heaviest) paper on the list
        setJob((j) => ({ ...j, cover: Math.max(0, c.papers.length - 1) }));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load the costing'));
  }, []);

  const sees = !!config?.canSeeCosts;
  const brochure = job.product === 'brochure';
  const qtyNum = Math.max(1, parseInt(job.qty, 10) || 1);
  const body: PrintJob = { product: job.product, pages: job.pages, paper: job.paper, cover: job.cover, coverSep: job.coverSep, lam: job.lam, fold: job.fold, size: job.size, sides: job.sides, qty: qtyNum, mode: job.mode };
  const key = JSON.stringify(body);

  // the quote follows what is chosen (a moment after the last key)
  useEffect(() => {
    if (!config) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .post<Result>('/costing/print/quote', JSON.parse(key))
        .then((r) => {
          if (live) {
            setResult(r);
            setError('');
          }
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not work out the costing'));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, config]);

  const set = (patch: Partial<typeof job>) => setJob((j) => ({ ...j, ...patch }));
  async function saveQuote() {
    if (!saving || saving.busy) return;
    setSaving({ ...saving, busy: true, err: '' });
    try {
      const saved = await api.post<{ id: number }>('/costing/print/quotes', { ...body, clientName: saving.client, phone: saving.phone, note: saving.note });
      setSaving(null);
      onSaved?.(saved.id);
    } catch (e) {
      setSaving({ ...saving, busy: false, err: e instanceof Error ? e.message : 'Could not save the quote' });
    }
  }
  const saveBox = saving && (
    <div className="no-print" style={{ marginTop: 'var(--space-3)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)', maxWidth: 520 }}>
      <div className="card-kicker">Keep this costing as a quote for a client</div>
      <StaffClientPicker onPick={(c) => setSaving({ ...saving, client: c.name, phone: c.phone })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Client name *</label>
          <input className="input" value={saving.client} onChange={(e) => setSaving({ ...saving, client: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Phone (optional)</label>
          <input className="input" value={saving.phone} onChange={(e) => setSaving({ ...saving, phone: e.target.value })} placeholder="07xx xxx xxx" />
        </div>
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>Note (optional)</label>
        <input className="input" value={saving.note} onChange={(e) => setSaving({ ...saving, note: e.target.value })} />
      </div>
      {saving.err && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{saving.err}</p>}
      <div>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving.busy || saving.client.trim().length < 2} onClick={saveQuote}>
          Save quote
        </button>{' '}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSaving(null)}>Cancel</button>
      </div>
      <p className="note" style={{ margin: 0 }}>The costing is kept as it is now, for 14 days. Later changes to the printer's rates do not change it. Under Saved quotes, print it as a quotation, email it or send it on WhatsApp, agree the price with the client, then capture it as an order.</p>
    </div>
  );
  const startSave = () => setSaving(saving ? null : { client: '', phone: '', note: '', busy: false, err: '' });
  const chip = (text: string, on: boolean, onClick: () => void) => (
    <button key={text} type="button" className={'btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary')} aria-pressed={on} onClick={onClick}>
      {text}
    </button>
  );
  const check = (text: string, on: boolean, onClick: () => void) => (
    <label key={text} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: 400, margin: '4px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={onClick} />
      {text}
    </label>
  );

  if (!config) return <p className="note">{loadError || 'Loading…'}</p>;
  const papers = config.papers;
  const unitName = brochure ? 'piece' : 'copy';

  const views: [View, string][] = [['calc', 'Calculator'], ['list', 'Price list']];
  if (isAdmin) views.push(['rates', 'Rates']);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="no-print seg" role="radiogroup" aria-label="Brochures and eulogies" style={{ maxWidth: 520 }}>
        {views.map(([id, text]) => (
          <label key={id} className={'seg-opt' + (view === id ? ' checked' : '')}>
            <input type="radio" name="pcview" checked={view === id} onChange={() => setView(id)} />
            {text}
          </label>
        ))}
      </div>

      {view === 'calc' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 'var(--space-6)', alignItems: 'start' }}>
          <div className="no-print" style={{ display: 'grid', gap: 'var(--space-5)' }}>
            <div>
              <div style={label}>Product</div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{PRINT_PRODUCTS.map((p) => chip(PRINT_PRODUCT_LABEL[p], job.product === p, () => set({ product: p })))}</div>
            </div>

            {!brochure ? (
              <>
                <div>
                  <div style={label}>Pages — {job.pages / 4} × A3 per copy</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{PRINT_PAGE_OPTIONS.map((p) => chip(String(p), job.pages === p, () => set({ pages: p })))}</div>
                </div>
                <div>
                  <div style={label}>Inside paper</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{papers.map((p, i) => chip(p, job.paper === i, () => set({ paper: i })))}</div>
                </div>
                <div>
                  {check('Separate cover paper', job.coverSep, () => set({ coverSep: !job.coverSep }))}
                  {check('Laminate cover', job.lam, () => set({ lam: !job.lam }))}
                  {check('Folding / creasing', job.fold, () => set({ fold: !job.fold }))}
                </div>
                {job.coverSep && (
                  <div>
                    <div style={label}>Cover paper (replaces one sheet)</div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{papers.map((p, i) => chip(p, job.cover === i, () => set({ cover: i })))}</div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div>
                  <div style={label}>Size — {PRINT_UPS[job.size]} per A3</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{(['A4', 'B5'] as const).map((z) => chip(z, job.size === z, () => set({ size: z })))}</div>
                </div>
                <div>
                  <div style={label}>Printing</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {chip('Single side', job.sides === 1, () => set({ sides: 1 }))}
                    {chip('Double side', job.sides === 2, () => set({ sides: 2 }))}
                  </div>
                </div>
                <div>
                  <div style={label}>Paper</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{papers.map((p, i) => chip(p, job.paper === i, () => set({ paper: i })))}</div>
                </div>
                <div>{check('Laminate sheets', job.lam, () => set({ lam: !job.lam }))}</div>
              </>
            )}

            <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0, width: 160 }}>
                <label>{brochure ? 'Pieces' : 'Copies'}</label>
                <input className="input" inputMode="numeric" value={job.qty} onChange={(e) => set({ qty: e.target.value.replace(/[^\d]/g, '') })} onBlur={() => set({ qty: String(qtyNum) })} />
              </div>
              {sees && (
                <div>
                  <div style={label}>Markup</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {chip('By quantity', job.mode === 'tier', () => set({ mode: 'tier' }))}
                    {chip('Flat', job.mode === 'flat', () => set({ mode: 'flat' }))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
            {!result ? (
              <p className="note">Working it out…</p>
            ) : (
              <>
                <div style={{ background: 'var(--color-accent)', color: '#fff', padding: 'var(--space-5)' }}>
                  <div style={{ fontSize: 13 }}>Price per {unitName} (incl. VAT)</div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 56, fontWeight: 700, lineHeight: 1.1 }}>KES {f2(result.unitTotal)}</div>
                  <div style={{ fontSize: 15 }}>
                    Job total KES {fmtNum(result.total)}
                    {result.markupPct != null && <> · markup {fmtNum(result.markupPct, 1)}%</>}
                  </div>
                </div>
                <div className="card-kicker" style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>{sees ? 'Internal cost breakdown' : 'Cost breakdown'}</div>
                <div style={{ borderTop: '1px solid var(--color-divider)' }}>
                  {result.lines.map((l) => (
                    <div key={l.label} style={{ display: 'flex', gap: 'var(--space-2)', padding: '7px 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 14 }}>
                      <span style={{ flex: 1 }}>
                        {l.label}
                        <div className="text-muted" style={{ fontSize: 12 }}>{l.note}</div>
                      </span>
                      <b style={numStyle}>{fmtNum(l.amount)}</b>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gap: 4, marginTop: 'var(--space-3)', borderTop: '2px solid var(--color-divider)', paddingTop: 'var(--space-2)' }}>
                  <Row text="Total cost" value={fmtNum(result.cost)} />
                  {result.markupPct != null && <Row text={`Markup ${fmtNum(result.markupPct, 1)}%`} value={fmtNum(result.markup ?? 0)} />}
                  <Row text="Price before VAT" value={fmtNum(result.priceExVat)} />
                  <Row text={`VAT ${Math.round(VAT_RATE * 100)}%`} value={fmtNum(result.vat)} />
                  <div style={{ borderTop: '2px solid var(--color-divider)', marginTop: 4, paddingTop: 4 }}>
                    <Row text="Total payable" value={fmtNum(result.total)} bold />
                  </div>
                </div>
                <div className="text-muted" style={{ fontSize: 12, marginTop: 'var(--space-2)' }}>
                  {result.profit != null && <>Profit on job {fmtKsh(result.profit)} · </>}
                  {fmtNum(result.sheets)} A3 sheets in total
                </div>
                <div className="no-print" style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm blueprint" onClick={startSave}>
                    Save as quote to print, email or WhatsApp
                  </button>
                </div>
                {saveBox}
              </>
            )}
          </div>
        </div>
      )}

      {view === 'list' && <PriceListView job={job} papers={papers} sees={sees} set={set} chip={chip} />}

      {view === 'rates' && isAdmin && <PrintRates />}
    </div>
  );
}

function Row({ text, value, bold, big }: { text: string; value: string; bold?: boolean; big?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400, fontSize: big ? 18 : 14 }}>
      <span>{text}</span>
      <span style={numStyle}>{value}</span>
    </div>
  );
}

function PriceListView({
  job,
  papers,
  sees,
  set,
  chip,
}: {
  job: { paper: number; cover: number; coverSep: boolean; lam: boolean; fold: boolean; mode: 'tier' | 'flat' };
  papers: string[];
  sees: boolean;
  set: (p: { paper?: number }) => void;
  chip: (text: string, on: boolean, onClick: () => void) => JSX.Element;
}) {
  const [list, setList] = useState<PriceList | null>(null);
  const [error, setError] = useState('');
  const body = useMemo(() => JSON.stringify({ paper: job.paper, cover: job.cover, coverSep: job.coverSep, lam: job.lam, fold: job.fold, mode: sees ? job.mode : 'tier' }), [job.paper, job.cover, job.coverSep, job.lam, job.fold, job.mode, sees]);
  useEffect(() => {
    let live = true;
    api
      .post<PriceList>('/costing/print/pricelist', JSON.parse(body))
      .then((r) => live && (setList(r), setError('')))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the price list'));
    return () => {
      live = false;
    };
  }, [body]);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <div style={label}>Paper</div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{papers.map((p, i) => chip(p, job.paper === i, () => set({ paper: i })))}</div>
        <p className="note" style={{ marginBottom: 0 }}>Booklets use the cover, lamination and folding choices made on the Calculator{job.coverSep ? ` (separate cover: ${papers[job.cover]})` : ''}{job.lam ? ', laminated' : ''}.</p>
      </div>
      {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
      {list && (
        <>
          <div>
            <div className="card-kicker">Eulogies &amp; company profiles</div>
            <p className="note" style={{ marginTop: 0 }}>Price per copy, VAT inclusive, KES. Design, proofing and delivery are spread across the run.</p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Pages</th>
                    <th>A3 sheets</th>
                    {list.bookletQtys.map((q) => (
                      <th key={q} style={{ textAlign: 'right' }}>{q} copies</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.booklets.map((r) => (
                    <tr key={r.pages}>
                      <td><b>{r.pages}</b></td>
                      <td>{r.sheets}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} style={numStyle}>{f2(c)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="card-kicker">Brochures</div>
            <p className="note" style={{ marginTop: 0 }}>Price per piece, VAT inclusive, KES. Includes wastage and the job design fee.</p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Brochure</th>
                    <th>Per A3</th>
                    {list.brochureQtys.map((q) => (
                      <th key={q} style={{ textAlign: 'right' }}>{fmtNum(q)} pcs</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.brochures.map((r) => (
                    <tr key={r.name}>
                      <td><b>{r.name}</b></td>
                      <td>{r.ups}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} style={numStyle}>{f2(c)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Admin: the printer's rates
function PrintRates() {
  const [s, setS] = useState<PrintSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api
      .get<PrintSettings>('/costing/print/settings')
      .then(setS)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the rates'));
  }, []);
  if (!s) return <p className="note">{error || 'Loading…'}</p>;
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const edit = (next: PrintSettings) => {
    setS(next);
    setSaved(false);
  };
  async function save() {
    if (!s) return;
    const problem = printSettingsProblem(s);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      setS(await api.put<PrintSettings>('/costing/print/settings', s));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }
  const input = (value: number, onChange: (v: number) => void, width = 100) => (
    <input className="input" style={{ width, textAlign: 'right' }} inputMode="decimal" defaultValue={value} key={value} onBlur={(e) => onChange(num(e.target.value))} />
  );
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <p className="note" style={{ margin: 0 }}>The printer's rates, all in KES and as the printer quotes them (the sample figures are placeholders until the real quotes are entered). Prices to the customer include VAT; the rates here do not.</p>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadFile('/costing/rates.xlsx', 'job-costing-supplier-price-check.xlsx').catch(() => undefined)} title="Every material, service, paper and fee Job Costing uses, with the rate held now and empty columns for supplier quotes">
          Supplier price-check sheet (Excel)
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div>
          <div className="card-kicker">A3 sheet cost</div>
          <table className="table">
            <thead>
              <tr>
                <th>Paper</th>
                <th style={{ textAlign: 'right' }}>1 side</th>
                <th style={{ textAlign: 'right' }}>2 sides</th>
              </tr>
            </thead>
            <tbody>
              {s.papers.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td style={numStyle}>{input(p.one, (v) => edit({ ...s, papers: s.papers.map((x, j) => (j === i ? { ...x, one: v } : x)) }), 80)}</td>
                  <td style={numStyle}>{input(p.two, (v) => edit({ ...s, papers: s.papers.map((x, j) => (j === i ? { ...x, two: v } : x)) }), 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="card-kicker">Services &amp; fees</div>
          <table className="table">
            <tbody>
              {PRINT_FEE_LABELS.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    <div className="text-muted" style={{ fontSize: 11 }}>{f.unit}</div>
                  </td>
                  <td style={numStyle}>{input(s.fees[f.key], (v) => edit({ ...s, fees: { ...s.fees, [f.key]: v } }), 110)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="card-kicker">Markup tiers</div>
          <p className="note" style={{ marginTop: 0 }}>Chosen by quantity (copies or pieces). “Flat” on the Calculator uses the first tier only.</p>
          <div className="field" style={{ margin: '0 0 var(--space-3)' }}>
            <label>Lowest margin without approval (% on cost)</label>
            {input(s.floorMarginPct, (v) => edit({ ...s, floorMarginPct: v }), 90)}
            <div className="text-muted" style={{ fontSize: 11 }}>On a saved quote, a price agreed below cost plus this margin waits for a manager's approval.</div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>From qty</th>
                <th style={{ textAlign: 'right' }}>Markup %</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {s.tiers.map((t, i) => (
                <tr key={i}>
                  <td>{i === 0 ? <b>1</b> : input(t.min, (v) => edit({ ...s, tiers: s.tiers.map((x, j) => (j === i ? { ...x, min: Math.round(v) } : x)) }), 90)}</td>
                  <td style={numStyle}>{input(t.pct, (v) => edit({ ...s, tiers: s.tiers.map((x, j) => (j === i ? { ...x, pct: v } : x)) }), 80)}</td>
                  <td>{i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit({ ...s, tiers: s.tiers.filter((_, j) => j !== i) })}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit({ ...s, tiers: [...s.tiers, { min: (s.tiers[s.tiers.length - 1]?.min ?? 0) + 100, pct: s.tiers[s.tiers.length - 1]?.pct ?? 20 }] })}>
            + Add a tier
          </button>
        </div>
      </div>
      {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
      <div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save the rates'}
        </button>
        {saved && <span className="tag tag-accent" style={{ marginLeft: 'var(--space-2)' }}>Saved</span>}
      </div>
    </div>
  );
}
