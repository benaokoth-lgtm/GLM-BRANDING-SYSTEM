import { useCallback, useEffect, useState } from 'react';
import { DTF_PRODUCTS, DTF_PRODUCT_LABEL } from '@glm/shared';
import type { DtfProduct } from '@glm/shared';
import { useSubTab } from '../state/SubNavContext';
import { api } from '../api/client';
import DtfDashboard from '../components/dtf/DtfDashboard';
import DtfRolls from '../components/dtf/DtfRolls';
import DtfSales from '../components/dtf/DtfSales';
import DtfJobs from '../components/dtf/DtfJobs';
import DtfSetup from '../components/dtf/DtfSetup';
import ArtworkRate from '../components/dtf/ArtworkRate';
import DtfApprovals from '../components/dtf/DtfApprovals';
import type { DtfData } from '../components/dtf/shared';

type Tab = 'dashboard' | 'rolls' | 'sales' | 'jobs' | 'approvals' | 'rate' | 'setup';

// Recording a new sale/job now happens on its own page next to New Walk-in
// Order (see pages/NewFilmOrder.tsx / NewArtworkOrder.tsx) — this page is
// manager-only (canManageDtf, see App.tsx's route guard) for the roll
// dashboard, roll install/close, sales/jobs history + reconciliation, and
// pricing Setup.
const MANAGER_TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['rolls', 'Rolls'],
  ['sales', 'Film Sales'],
  ['jobs', 'Artwork Jobs'],
  ['approvals', 'Price Approvals'],
  ['rate', 'Artwork price'],
  ['setup', 'Setup'],
];

export default function Dtf() {
  const [product, setProduct] = useState<DtfProduct>(() => {
    try {
      return localStorage.getItem('glm_dtf_product') === 'uv' ? 'uv' : 'dtf';
    } catch {
      return 'dtf';
    }
  });
  const [data, setData] = useState<DtfData | null>(null);
  const [tab, setTab] = useSubTab<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DtfData>(`/dtf/data?product=${product}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load DTF data');
    }
  }, [product]);

  function chooseProduct(p: DtfProduct) {
    if (p === product) return;
    try {
      localStorage.setItem('glm_dtf_product', p);
    } catch {
      /* the choice just is not remembered */
    }
    setData(null);
    setError(null);
    setProduct(p);
  }

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <p className="note">{error ?? 'Loading…'}</p>;

  const label = DTF_PRODUCT_LABEL[data.product];
  const tabs = MANAGER_TABS;
  const active = tab && tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  const props = { data, reload: load, setError };

  return (
    <>
      <div>
        <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }} role="group" aria-label="Product">
          {DTF_PRODUCTS.map((p) => (
            <button key={p} type="button" className={'btn btn-sm ' + (data.product === p ? 'btn-primary' : 'btn-secondary')} aria-pressed={data.product === p} onClick={() => chooseProduct(p)}>
              {DTF_PRODUCT_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="card-kicker">{label} printing</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 42, lineHeight: 1.05, margin: 0 }}>
          {tabs.find(([t]) => t === active)?.[1]}
        </h1>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {tabs.map(([t, label]) => (
          <button key={t} type="button" className={`btn ${active === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t)}>
            {label}
            {t === 'approvals' && !!data.pendingApprovals && <span className="tag tag-accent" style={{ marginLeft: 6 }}>{data.pendingApprovals}</span>}
          </button>
        ))}
      </div>

      {error && (
        <p className="note" role="alert" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
          {error}
        </p>
      )}

      {active === 'dashboard' && <DtfDashboard data={data} go={setTab} />}
      {active === 'rolls' && <DtfRolls {...props} />}
      {active === 'sales' && <DtfSales {...props} />}
      {active === 'jobs' && <DtfJobs {...props} />}
      {active === 'approvals' && <DtfApprovals {...props} />}
      {active === 'rate' && <ArtworkRate {...props} />}
      {active === 'setup' && <DtfSetup {...props} />}
    </>
  );
}
