import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import DtfDashboard from '../components/dtf/DtfDashboard';
import DtfRolls from '../components/dtf/DtfRolls';
import DtfSales from '../components/dtf/DtfSales';
import DtfJobs from '../components/dtf/DtfJobs';
import DtfSetup from '../components/dtf/DtfSetup';
import type { DtfData } from '../components/dtf/shared';

type Tab = 'dashboard' | 'rolls' | 'sales' | 'jobs' | 'setup';

const MANAGER_TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['rolls', 'Rolls'],
  ['sales', 'Film Sales'],
  ['jobs', 'Artwork Jobs'],
  ['setup', 'Setup'],
];
const RECORDER_TABS: [Tab, string][] = [
  ['sales', 'Film Sales'],
  ['jobs', 'Artwork Jobs'],
];

export default function Dtf() {
  const [data, setData] = useState<DtfData | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DtfData>('/dtf/data'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load DTF data');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <p className="note">{error ?? 'Loading…'}</p>;

  const tabs = data.canManage ? MANAGER_TABS : RECORDER_TABS;
  const active = tab && tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  const props = { data, reload: load, setError };

  return (
    <>
      <div>
        <div className="card-kicker">DTF printing</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 42, lineHeight: 1.05, margin: 0 }}>
          {tabs.find(([t]) => t === active)?.[1]}
        </h1>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {tabs.map(([t, label]) => (
          <button key={t} type="button" className={`btn ${active === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t)}>
            {label}
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
      {active === 'setup' && <DtfSetup {...props} />}
    </>
  );
}
