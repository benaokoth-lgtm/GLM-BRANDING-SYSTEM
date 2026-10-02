import { dtfDashboard, fmtKsh, fmtNum } from '@glm/shared';
import { Card, right } from './shared';
import type { DtfData } from './shared';

const ksh = (n: number | null) => (n == null ? '—' : fmtKsh(n));

export default function DtfDashboard({ data, go }: { data: DtfData; go: (tab: 'sales' | 'jobs') => void }) {
  const { settings } = data;
  const d = dtfDashboard(settings, data.rolls, data.sales, data.jobs);
  const started = d.rolls.filter((r) => r.started);
  const closed = started.filter((r) => r.closed);
  const maxRev = Math.max(1, ...started.map((r) => r.revenue));
  const wScale = Math.max(settings.wastageTolerancePct * 2, ...closed.map((r) => r.wastagePct), 1);

  const kpis: [string, string, string][] = [
    ['Net profit · Ksh', fmtKsh(d.netProfit), `Revenue ${fmtKsh(d.revenue)} − roll costs ${fmtKsh(d.totalCost)}`],
    ['Profit per closed roll', ksh(d.profitPerClosedRoll), `${d.closedCount} closed of ${d.startedCount} rolls`],
    ['Metres used', `${fmtNum(d.usedM, 1)} m`, `of ${fmtNum(d.installedM)} m installed`],
    ['Wastage', `${fmtNum(d.wastageM, 1)} m`, `${fmtKsh(d.wastageKes)} · tolerance ${settings.wastageTolerancePct}%`],
  ];
  const rows: [string, string, string][] = [
    ['Metres used', `${fmtNum(d.filmM, 1)} m`, `${fmtNum(d.artM, 1)} m`],
    ['Revenue (Ksh)', fmtKsh(d.filmRev), fmtKsh(d.artRev)],
    ['Revenue per metre', ksh(d.filmRevPerM), ksh(d.artRevPerM)],
    ['Margin per metre', ksh(d.filmMarginPerM), ksh(d.artMarginPerM)],
    ['Share of output', `${fmtNum(d.filmShare * 100, 1)}%`, `${fmtNum(d.artShare * 100, 1)}%`],
  ];

  return (
    <>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={() => go('sales')}>+ Film sale</button>
        <button type="button" className="btn btn-primary" onClick={() => go('jobs')}>+ Artwork job</button>
      </div>

      {d.orphanCount > 0 && (
        <div className="card" style={{ padding: 'var(--space-3) var(--space-4)', borderColor: 'var(--color-accent)' }}>
          ⚠ {d.orphanCount} sale(s)/job(s) point at a roll that hasn't started (no install date). Fix the roll before trusting these numbers.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
        {kpis.map(([k, v, m]) => (
          <Card key={k}>
            <div className="card-kicker">{k}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 34, lineHeight: 1, whiteSpace: 'nowrap', margin: 'var(--space-2) 0' }}>{v}</div>
            <div className="card-meta">{m}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))', gap: 'var(--space-6)' }}>
        <Card title="Printed film vs artwork">
          <table className="table">
            <thead>
              <tr>
                <th>Measure</th>
                <th style={right}>Printed film</th>
                <th style={right}>Artwork</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([m, a, b]) => (
                <tr key={m}>
                  <td>{m}</td>
                  <td style={right}>{a}</td>
                  <td style={right}>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Margin per metre = revenue per metre − average roll cost per metre ({fmtKsh(d.costPerM)}).
          </p>
        </Card>

        <Card title="Revenue by roll (Ksh)">
          {started.length === 0 && <p className="note">No rolls yet — install your first roll.</p>}
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {started.map((r) => (
              <div key={r.roll.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 12 }}>
                <div style={{ width: 76 }}>{r.roll.id}</div>
                <div style={{ flex: 1, display: 'flex', height: 22, border: '1px solid var(--color-divider)' }}>
                  <div style={{ width: `${(r.filmRev / maxRev) * 100}%`, background: 'var(--color-accent)' }} />
                  <div style={{ width: `${(r.artRev / maxRev) * 100}%`, background: 'var(--color-accent-300)' }} />
                </div>
                <div style={{ width: 96, ...right }}>{fmtKsh(r.revenue)}</div>
              </div>
            ))}
          </div>
          <div className="note" style={{ margin: 'var(--space-2) 0 var(--space-4)' }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--color-accent)', marginRight: 4 }} />Film
            <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--color-accent-300)', margin: '0 4px 0 12px' }} />Artwork
          </div>

          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>Wastage per closed roll (%)</div>
          {closed.length === 0 && <p className="note">No closed rolls yet.</p>}
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {closed.map((r) => (
              <div key={r.roll.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 12 }}>
                <div style={{ width: 76 }}>{r.roll.id}</div>
                <div style={{ flex: 1, position: 'relative', height: 22, border: '1px solid var(--color-divider)' }}>
                  <div style={{ height: '100%', width: `${(r.wastagePct / wScale) * 100}%`, background: 'var(--color-accent-700)' }} />
                  <div title="Tolerance" style={{ position: 'absolute', top: 0, bottom: 0, width: 1, background: 'var(--color-text)', left: `${(settings.wastageTolerancePct / wScale) * 100}%` }} />
                </div>
                <div style={{ width: 96, ...right }}>{fmtNum(r.wastagePct, 1)}%</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
