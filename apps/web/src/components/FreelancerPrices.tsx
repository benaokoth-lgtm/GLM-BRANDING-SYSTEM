import { useEffect, useMemo, useState } from 'react';
import { fmtKsh, fmtNum } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog, resetCatalogCache } from '../hooks/useCatalog';
import type { CatalogMaterial, CatalogService, CompanySettings } from '../api/models';
import { Card, Notice } from '../pages/accounting/shared';

// Master Data → Freelancer Prices: the prices a Freelancer Sales order is offered. One default percentage off the GLM price (rounded to the nearest 5 or 10 shillings, or not at all) applies to every
// item; any single item can instead have a price typed by hand, which wins and stays when the GLM price changes. The list shows GLM price, Freelancer price and which are typed by hand. (DTF and UV DTF
// rates have their own Freelancer switch under DTF → Artwork price and DTF → Setup.)

type Item = (CatalogService | CatalogMaterial) & { freelancerPrice?: number; freelancerOverride?: number | null };

function Row({ item, kind, onSaved }: { item: Item; kind: 'services' | 'materials'; onSaved: () => void }) {
  const [v, setV] = useState(item.freelancerOverride != null ? String(item.freelancerOverride) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => setV(item.freelancerOverride != null ? String(item.freelancerOverride) : ''), [item.freelancerOverride]);
  const typed = item.freelancerOverride != null;
  const effective = item.freelancerPrice ?? item.price;
  const diff = item.price > 0 ? ((item.price - effective) / item.price) * 100 : 0;
  const n = Number(v);
  const changed = v.trim() === '' ? typed : Number.isFinite(n) && n > 0 && n !== item.freelancerOverride;

  async function save(value: number | null) {
    setBusy(true);
    setErr('');
    try {
      await api.put(`/master-data/${kind}/${item.id}`, { freelancerOverride: value });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{item.name}</td>
      <td style={{ textAlign: 'right' }}>{fmtKsh(item.price)}</td>
      <td style={{ textAlign: 'right' }}>
        <b>{fmtKsh(effective)}</b> {typed ? <span className="tag tag-accent">typed</span> : <span className="text-muted" style={{ fontSize: 11 }}>from %</span>}
      </td>
      <td style={{ textAlign: 'right' }} className="text-muted">{fmtNum(diff, 1)}% less</td>
      <td>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="follow %" value={v} onChange={(e) => setV(e.target.value)} aria-label={`Freelancer price of ${item.name}`} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !changed || (v.trim() !== '' && !(n > 0))} onClick={() => save(v.trim() === '' ? null : n)}>
            Save
          </button>
          {err && <span className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</span>}
        </div>
      </td>
    </tr>
  );
}

export default function FreelancerPrices() {
  const { services, materials, reload } = useCatalog();
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [pct, setPct] = useState('');
  const [round, setRound] = useState('5');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [part, setPart] = useState<'services' | 'materials'>('services');

  useEffect(() => {
    api
      .get<CompanySettings & { freelancerDiscountPct?: number; freelancerRoundTo?: number }>('/master-data/settings')
      .then((s) => {
        setSettings(s);
        setPct(String(s.freelancerDiscountPct ?? 0));
        setRound(String(s.freelancerRoundTo ?? 5));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings'));
  }, []);

  async function saveSettings() {
    setBusy(true);
    setError(undefined);
    setMsg(undefined);
    try {
      await api.put('/master-data/settings', { freelancerDiscountPct: Number(pct) || 0, freelancerRoundTo: Number(round) || 0 });
      resetCatalogCache();
      reload();
      setMsg('Saved. Freelancer prices follow the new percentage, except those typed by hand.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const list = (part === 'services' ? services : materials) as Item[];
  const shown = useMemo(() => list.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase())), [list, q]);
  const pctN = Number(pct);
  const problem = !(pctN >= 0 && pctN <= 90) ? 'The percentage must be from 0 to 90' : null;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card title="Freelancer prices" hint="What a Freelancer Sales order is offered: the GLM price less one percentage, rounded. Any single item can have its own price typed by hand below, which wins. GLM Sales is unaffected.">
        <Notice error={error} message={msg} />
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Freelancer prices are this % less than GLM</label>
            <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Default percentage off GLM prices" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Round to the nearest (Ksh)</label>
            <select className="input" style={{ maxWidth: 160 }} value={round} onChange={(e) => setRound(e.target.value)} aria-label="Rounding">
              <option value="5">5 shillings</option>
              <option value="10">10 shillings</option>
              <option value="0">Exact (no rounding)</option>
            </select>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !settings || !!problem} onClick={saveSettings}>
            Save
          </button>
        </div>
        {problem && <p className="note" style={{ color: 'var(--color-error)' }}>{problem}</p>}
        <p className="note" style={{ marginBottom: 0 }}>With 0% the Freelancer list is the GLM list. The rates for DTF and UV DTF film and artwork are set under DTF → Artwork price and DTF → Setup (switch to Freelancer).</p>
      </Card>

      <Card title="Prices by item">
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <div className="seg" role="radiogroup" aria-label="Which list">
            {([['services', 'Services'], ['materials', 'Stock items']] as const).map(([k, label]) => (
              <label key={k} className={'seg-opt' + (part === k ? ' checked' : '')}>
                <input type="radio" name="flpart" checked={part === k} onChange={() => setPart(k)} />
                {label}
              </label>
            ))}
          </div>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>GLM price</th>
                <th style={{ textAlign: 'right' }}>Freelancer price</th>
                <th style={{ textAlign: 'right' }}>Difference</th>
                <th>Type a price (blank = follow the %)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <Row key={`${part}-${i.id}`} item={i} kind={part} onSaved={() => { resetCatalogCache(); reload(); }} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="note">Nothing matches.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
