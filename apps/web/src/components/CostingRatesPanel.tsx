import { Fragment, useState } from 'react';
import { COSTING_BASIS_LABEL, COSTING_JOB_LABEL, COSTING_JOB_TYPES, costingBasesFor, fmtKsh } from '@glm/shared';
import type { CostingBasis, CostingJobType, CostingJobTypeRow, CostingKind, CostingRateRow } from '@glm/shared';
import { api, downloadFile } from '../api/client';
import { Card, Loading, Notice, Tag, numStyle, useLoad } from '../pages/accounting/shared';

// Sales → Job Costing → Rates (Admin): the numbers behind the costing. Two lists — the MATERIALS we buy and the SERVICES we pay for — each with what the supplier
// charges us, how it is charged (per A3 sheet, per sqm, per unit, per job) and which kinds of job it is costed on. Anything can be added, changed or taken off the list; a
// change shows in the next costing straight away. Each kind of job also has its own markup, wastage and (business cards) cards to an A3 sheet.

interface Data {
  jobTypes: CostingJobTypeRow[];
  rates: CostingRateRow[];
}

const n = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const ONLY_FOR: Record<string, string> = { '': 'Every finish', lam: 'Laminated cards only', frost: 'Frosted cards only' };

// ── a kind of job: its markup, wastage and cards to a sheet
function JobTypeRow({ t, onSaved }: { t: CostingJobTypeRow; onSaved: () => void }) {
  const [f, setF] = useState({ marginPct: String(t.marginPct), floorMarginPct: String(t.floorMarginPct), wastagePct: String(t.wastagePct), cardsPerSheet: String(t.cardsPerSheet), spareSheets: String(t.spareSheets) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const cards = t.key === 'cards';
  const dirty = f.marginPct !== String(t.marginPct) || f.floorMarginPct !== String(t.floorMarginPct) || f.wastagePct !== String(t.wastagePct) || f.cardsPerSheet !== String(t.cardsPerSheet) || f.spareSheets !== String(t.spareSheets);
  async function save() {
    setBusy(true);
    setErr('');
    setSaved(false);
    try {
      await api.put(`/costing/job-types/${t.key}`, { marginPct: n(f.marginPct), floorMarginPct: n(f.floorMarginPct), wastagePct: n(f.wastagePct), cardsPerSheet: Math.round(n(f.cardsPerSheet)), spareSheets: Math.round(n(f.spareSheets)) });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  const input = (k: keyof typeof f, w = 90) => <input className="input" style={{ width: w }} inputMode="decimal" value={f[k]} onChange={(e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); }} />;
  return (
    <tr>
      <td><b>{COSTING_JOB_LABEL[t.key]}</b></td>
      <td>{input('marginPct')}</td>
      <td>{input('floorMarginPct')}</td>
      <td>{cards ? <span className="text-muted">—</span> : input('wastagePct')}</td>
      <td>{cards ? input('cardsPerSheet') : <span className="text-muted">—</span>}</td>
      <td>{cards ? input('spareSheets') : <span className="text-muted">—</span>}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>Save</button>
        {saved && <span className="tag tag-accent" style={{ marginLeft: 6 }}>Saved</span>}
        {err && <span style={{ color: 'var(--color-error)', marginLeft: 6 }}>{err}</span>}
      </td>
    </tr>
  );
}

// ── one rate: shown as a row, edited in place
interface Draft {
  name: string;
  jobTypes: CostingJobType[];
  basis: CostingBasis;
  cost: string;
  defaultOn: boolean;
  onlyFor: '' | 'lam' | 'frost';
  active: boolean;
}
const blank = (): Draft => ({ name: '', jobTypes: ['indoor'], basis: 'sqm', cost: '', defaultOn: true, onlyFor: '', active: true });
const draftOf = (r: CostingRateRow): Draft => ({ name: r.name, jobTypes: r.jobTypes, basis: r.basis, cost: String(r.cost), defaultOn: r.defaultOn, onlyFor: r.onlyFor, active: r.active });

/** The fields of a rate, for adding one or changing one. */
function RateFields({ d, set }: { d: Draft; set: (d: Draft) => void }) {
  const bases = costingBasesFor(d.jobTypes);
  const toggle = (k: CostingJobType) => {
    const jobTypes = d.jobTypes.includes(k) ? d.jobTypes.filter((x) => x !== k) : [...d.jobTypes, k];
    // keep the way it is charged to one the chosen jobs allow
    const ok = costingBasesFor(jobTypes);
    set({ ...d, jobTypes, basis: ok.includes(d.basis) ? d.basis : (ok[0] ?? d.basis), onlyFor: jobTypes.includes('cards') ? d.onlyFor : '' });
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', alignItems: 'end' }}>
      <div className="field" style={{ margin: 0 }}>
        <label>Name</label>
        <input className="input" value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder="e.g. Eyelets, Foam board" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>Costed on</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
          {COSTING_JOB_TYPES.map((k) => (
            <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400 }}>
              <input type="checkbox" checked={d.jobTypes.includes(k)} onChange={() => toggle(k)} />
              {COSTING_JOB_LABEL[k]}
            </label>
          ))}
        </div>
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>Charged</label>
        <select className="input" value={d.basis} onChange={(e) => set({ ...d, basis: e.target.value as CostingBasis })}>
          {bases.map((b) => (
            <option key={b} value={b}>{COSTING_BASIS_LABEL[b]}</option>
          ))}
          {bases.length === 0 && <option value="">—</option>}
        </select>
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>Supplier cost (Ksh, VAT not included)</label>
        <input className="input" inputMode="decimal" value={d.cost} onChange={(e) => set({ ...d, cost: e.target.value })} />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label>In a new costing</label>
        <select className="input" value={d.defaultOn ? 'on' : 'off'} onChange={(e) => set({ ...d, defaultOn: e.target.value === 'on' })}>
          <option value="on">Ticked (switch off if not needed)</option>
          <option value="off">Optional extra (tick if needed)</option>
        </select>
      </div>
      {d.jobTypes.includes('cards') && (
        <div className="field" style={{ margin: 0 }}>
          <label>Business cards</label>
          <select className="input" value={d.onlyFor} onChange={(e) => set({ ...d, onlyFor: e.target.value as Draft['onlyFor'] })}>
            {Object.entries(ONLY_FOR).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function RateList({ kind, rates, onChanged }: { kind: CostingKind; rates: CostingRateRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(blank());
  const [adding, setAdding] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const mine = rates.filter((r) => r.kind === kind);
  const body = (d: Draft) => ({ kind, name: d.name, jobTypes: d.jobTypes, basis: d.basis, cost: n(d.cost), defaultOn: d.defaultOn, onlyFor: d.onlyFor, active: d.active });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }
  const add = async () => {
    if (await run(() => api.post('/costing/rates', body(adding)))) setAdding(blank());
  };
  const save = async (id: number) => {
    if (await run(() => api.put(`/costing/rates/${id}`, body(draft)))) setEditing(null);
  };
  const noun = kind === 'material' ? 'material' : 'service';

  return (
    <Card
      title={kind === 'material' ? 'Materials' : 'Services'}
      hint={kind === 'material' ? 'What we buy in for a job: boards, vinyl, banner, laminate and frosting film, frames.' : 'What a supplier or we charge to do the work: printing, cutting, mounting, finishing, installation, design, transport.'}
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Costed on</th>
              <th>Charged</th>
              <th style={numStyle}>Cost (Ksh)</th>
              <th>In a new costing</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <Fragment key={r.id}>
                <tr style={r.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    {r.name} {!r.active && <Tag>off the list</Tag>}
                  </td>
                  <td>
                    {r.jobTypes.map((k) => COSTING_JOB_LABEL[k]).join(', ')}
                    {r.onlyFor && <div className="text-muted" style={{ fontSize: 11 }}>{ONLY_FOR[r.onlyFor]}</div>}
                  </td>
                  <td>{COSTING_BASIS_LABEL[r.basis]}</td>
                  <td style={numStyle}>{fmtKsh(r.cost)}</td>
                  <td>{r.defaultOn ? 'Ticked' : 'Optional extra'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setErr(''); setDraft(draftOf(r)); setEditing(editing === r.id ? null : r.id); }}>
                      {editing === r.id ? 'Close' : 'Edit'}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--color-error)' }}
                      disabled={busy}
                      onClick={() => window.confirm(`Delete "${r.name}" from the list? To keep it but leave it out of costings, use Edit → untick "On the list".`) && run(() => api.del(`/costing/rates/${r.id}`))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {editing === r.id && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--color-surface)' }}>
                      <div style={{ padding: 'var(--space-2) 0', display: 'grid', gap: 'var(--space-3)' }}>
                        <RateFields d={draft} set={setDraft} />
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                          On the list (untick to leave it out of every costing without deleting it)
                        </label>
                        <div>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(r.id)}>Save</button>{' '}
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {mine.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted">No {noun}s yet — add one below.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {err && <p className="note" style={{ color: 'var(--color-error)' }}>{err}</p>}
      <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-3)' }}>
        <div className="card-kicker">Add a {noun}</div>
        <RateFields d={adding} set={setAdding} />
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || adding.name.trim().length < 2} onClick={add}>
            Add {noun}
          </button>
        </div>
      </div>
    </Card>
  );
}

export default function CostingRatesPanel() {
  const { data, error, loading, reload } = useLoad<Data>('/costing/rates');
  if (!data) return <Loading loading={loading} error={error} />;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <Notice error={error} />
      <p className="note" style={{ margin: 0 }}>
        The rates behind <b>Sales → Job Costing</b>. Enter what the supplier charges <b>us</b>, without VAT. A change shows in the next costing straight away; a costing is not saved, so nothing already quoted changes.
      </p>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadFile('/costing/rates.xlsx', 'job-costing-supplier-price-check.xlsx').catch(() => undefined)} title="Every material, service, paper and fee Job Costing uses, with the rate held now and empty columns for supplier quotes">
          Supplier price-check sheet (Excel)
        </button>
        <span className="text-muted" style={{ fontSize: 12, marginLeft: 'var(--space-2)' }}>For checking supplier prices: every item and service used here and under Brochures &amp; eulogies, with today's rate and blank columns for quotes.</span>
      </div>
      <Card title="Kinds of job" hint="The margin is a markup on cost: price = cost × (1 + margin %). The lowest margin is how far a salesperson may bargain a quote down with a client: a lower price needs Finance, the General Manager or Admin to approve it. Wastage is the extra material allowed for on signage. Business cards: how many fit on an A3 sheet, and the spare sheets added to every job.">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Margin (% on cost)</th>
                <th>Lowest margin without approval (%)</th>
                <th>Wastage (%)</th>
                <th>Cards per A3 sheet</th>
                <th>Spare A3 sheets</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.jobTypes.map((t) => (
                <JobTypeRow key={`${t.key}-${t.marginPct}-${t.wastagePct}-${t.cardsPerSheet}-${t.spareSheets}`} t={t} onSaved={reload} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <RateList kind="material" rates={data.rates} onChanged={reload} />
      <RateList kind="service" rates={data.rates} onChanged={reload} />
    </div>
  );
}
