import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../api/client';
import type { PnlData } from '../api/models';

type Preset = 'month' | 'quarter' | 'year' | 'last12';

function presetRange(preset: Preset, today: string): { from: string; to: string } {
  const y = today.slice(0, 4);
  const m = today.slice(5, 7);
  if (preset === 'month') return { from: `${y}-${m}-01`, to: today };
  if (preset === 'quarter') {
    const qm = Math.floor((Number(m) - 1) / 3) * 3 + 1;
    return { from: `${y}-${String(qm).padStart(2, '0')}-01`, to: today };
  }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  const d = new Date(today + 'T00:00:00');
  d.setMonth(d.getMonth() - 11);
  d.setDate(1);
  return { from: d.toISOString().slice(0, 10), to: today };
}

export default function PnL() {
  const today = todayStr();
  const initial = presetRange('month', today);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const [data, setData] = useState<PnlData | null>(null);
  const [loading, setLoading] = useState(true);
  const [cogsDraft, setCogsDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api
      .get<PnlData>(`/pnl?from=${fromDate}&to=${toDate}`)
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(load, [fromDate, toDate]);

  function applyPreset(preset: Preset) {
    const r = presetRange(preset, today);
    setFromDate(r.from);
    setToDate(r.to);
  }

  async function saveCogs() {
    const pct = Number(cogsDraft);
    if (Number.isNaN(pct) || pct < 0) return;
    try {
      await api.put('/pnl/cogs-pct', { cogsPct: pct });
      setCogsDraft(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update cost of sales %');
    }
  }

  if (loading || !data) return <p className="note">Loading…</p>;

  const cogsValue = cogsDraft ?? String(data.cogsPct);
  const maxTrendVal = Math.max(1, ...data.trend.map((t) => Math.max(t.revenue, Math.abs(t.netProfit))));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('month')}>
              This month
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('quarter')}>
              This quarter
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('year')}>
              Year to date
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => applyPreset('last12')}>
              Last 12 months
            </button>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={() => window.print()}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Print / PDF
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
        <div className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">Revenue (accrual)</div>
          <div className="card-title">{fmtKsh(data.revAccrual)}</div>
          <div className="text-muted" style={{ fontSize: 11 }}>
            {data.revChangePct === null ? 'No prior data' : `${data.revChangePct >= 0 ? '+' : ''}${data.revChangePct}% vs prior period`}
          </div>
        </div>
        <div className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">Revenue (cash received)</div>
          <div className="card-title">{fmtKsh(data.revCash)}</div>
        </div>
        <div className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">Gross profit</div>
          <div className="card-title">{fmtKsh(data.grossProfit)}</div>
        </div>
        <div className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">Net profit</div>
          <div className="card-title">{fmtKsh(data.netProfit)}</div>
          <div className="text-muted" style={{ fontSize: 11 }}>
            {data.profitChangePct === null ? 'No prior data' : `${data.profitChangePct >= 0 ? '+' : ''}${data.profitChangePct}% vs prior period`}
          </div>
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Profit &amp; Loss statement
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
            <span>Walk-in sales</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(data.revAccrualWalkin)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <span>Corporate sales (invoiced)</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(data.revAccrualCorp)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '8px 0', fontFamily: 'var(--font-heading)' }}>
            <span>Total revenue</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(data.revAccrual)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0', alignItems: 'center' }}>
            <span>
              Cost of sales (
              <input
                className="input no-print"
                style={{ width: 56, display: 'inline-block', padding: '2px 6px', height: 26 }}
                value={cogsValue}
                onChange={(e) => setCogsDraft(e.target.value)}
                onBlur={saveCogs}
              />
              <span className="no-print">%</span>
              <span className="print-only">{data.cogsPct}%</span> of revenue)
            </span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>({fmtKsh(data.cogs)})</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: '8px 0',
              borderTop: '1px solid var(--color-divider)',
              borderBottom: '2px solid var(--color-text)',
              fontFamily: 'var(--font-heading)',
              fontSize: 17,
            }}
          >
            <span>Gross profit</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtKsh(data.grossProfit)}</span>
          </div>
          {data.expenseCategories.map((cat) => (
            <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '6px 0' }}>
              <span>{cat}</span>
              <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>({fmtKsh(data.byCategory[cat] || 0)})</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: '8px 0', borderTop: '1px solid var(--color-divider)' }}>
            <span>Total operating expenses</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>({fmtKsh(data.totalExpenses)})</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: '10px 0',
              borderTop: '2px solid var(--color-text)',
              fontFamily: 'var(--font-heading)',
              fontSize: 20,
            }}
          >
            <span>Net profit</span>
            <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              {fmtKsh(data.netProfit)} ({data.netMarginPct}% margin)
            </span>
          </div>
        </div>
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          Cost of sales is estimated as a set % of revenue (adjust above). Categories below match GLM Branding's petty cash tracker
          (Printing Materials &amp; Consumables here covers indirect supplies — direct job materials are already in cost of sales).
        </p>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Revenue &amp; net profit — last 6 months
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', height: 150 }}>
          {data.trend.map((t) => (
            <div key={t.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
              <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120 }}>
                <div
                  style={{ width: 14, height: Math.round((t.revenue / maxTrendVal) * 120), background: 'var(--color-accent-300)' }}
                  title={fmtKsh(t.revenue)}
                />
                <div
                  style={{
                    width: 14,
                    height: Math.round((Math.abs(t.netProfit) / maxTrendVal) * 120),
                    background: t.netProfit >= 0 ? 'var(--color-accent-600)' : '#b23b2e',
                  }}
                  title={fmtKsh(t.netProfit)}
                />
              </div>
              <div className="text-muted" style={{ fontSize: 11 }}>
                {t.label}
              </div>
            </div>
          ))}
        </div>
        <div className="text-muted" style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: 11 }}>
          <span>Revenue</span>
          <span>Net profit</span>
        </div>
      </div>

      <p className="note no-print">
        Prior comparison period: {fmtDate(data.priorFrom)} → {fmtDate(data.priorTo)}. Add or remove operating expense entries under{' '}
        <Link to="/finance">Finance → Expenses</Link>.
      </p>
    </div>
  );
}
