import { useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../../api/client';
import { AsOfBar, Card, DateRangeBar, Loading, Notice, Tag, money, numStyle, printPage, useLoad, ymd } from './shared';
import type { Range } from './shared';

interface DepData {
  from: string;
  to: string;
  rows: { assetId: number; tag: string; name: string; category: string; condition: string; purchaseDate: string | null; method: string; cost: number; salvage: number; lifeYears: number | null; ratePct: number | null; chargedToDate: number; bookValue: number; monthlyCharge: number; thisPeriod: number }[];
  totals: { cost: number; chargedToDate: number; bookValue: number; thisPeriod: number };
}

export function DepreciationTab({ range }: { range: Range }) {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const { data, error, loading, reload } = useLoad<DepData>(`/accounting/depreciation?from=${range.from}&to=${range.to}&asOf=${asOf}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function runNow() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const r = await api.post<{ created: number }>('/accounting/depreciation/run', {});
      setMsg(r.created ? `${r.created} monthly charge(s) posted.` : 'Everything is already up to date.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <DateRangeBar range={range} />
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Notice error={err} message={msg} />
      <Loading loading={loading} error={error} />
      {data && (
        <Card
          title="Asset Depreciation"
          hint="Charged automatically, one month at a time, starting the month after purchase (the job runs when the server starts, every few hours, and whenever you open Accounting). Set a method for each asset under Finance → Asset Register."
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={runNow} disabled={busy}>
                Run now
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={printPage}>
                Print / PDF
              </button>
            </div>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Method</th>
                  <th>Bought</th>
                  <th style={numStyle}>Cost</th>
                  <th style={numStyle}>Salvage</th>
                  <th style={numStyle}>Per month</th>
                  <th style={numStyle}>This period</th>
                  <th style={numStyle}>Accumulated</th>
                  <th style={numStyle}>Book value</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      No assets in the register yet.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.assetId}>
                    <td>
                      <span className="text-muted">{r.tag}</span> {r.name} {r.condition === 'Retired' && <Tag>Retired</Tag>}
                    </td>
                    <td>
                      {r.method === 'None' ? <span className="text-muted">Not depreciating</span> : r.method === 'Straight-line' ? `Straight-line, ${r.lifeYears} yr` : `Reducing balance, ${r.ratePct}%`}
                    </td>
                    <td className="text-muted">{r.purchaseDate ? fmtDate(r.purchaseDate) : '—'}</td>
                    <td style={numStyle}>{money(r.cost)}</td>
                    <td style={numStyle}>{money(r.salvage)}</td>
                    <td style={numStyle}>{money(r.monthlyCharge)}</td>
                    <td style={numStyle}>{money(r.thisPeriod)}</td>
                    <td style={numStyle}>{money(r.chargedToDate)}</td>
                    <td style={{ ...numStyle, fontWeight: 700 }}>{money(r.bookValue)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={3}>Totals</td>
                  <td style={numStyle}>{money(data.totals.cost)}</td>
                  <td></td>
                  <td></td>
                  <td style={numStyle}>{money(data.totals.thisPeriod)}</td>
                  <td style={numStyle}>{money(data.totals.chargedToDate)}</td>
                  <td style={numStyle}>{money(data.totals.bookValue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
