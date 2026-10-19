import { useEffect, useState } from 'react';
import { cm2ToM2, fmtDate, fmtNum, todayStr } from '@glm/shared';
import type { LayoutPrint, LayoutSummary } from '@glm/shared';
import { api } from '../../api/client';
import { Card, right } from './shared';
import type { DtfTabProps } from './shared';

// DTF → Film layout, for INFORMATION ONLY: for each print with its sizes recorded, the film used (the length measured × the film width) against the total area of its artworks (each size ×
// how many), and how much of the film they fill. Nothing is charged, blocked or paid on it. It is not "wastage" (the roll left unused when it is closed): this is the space between and around
// the artworks inside the film that was used. A print whose artworks add up to more than its film has a size or length wrong somewhere, and is marked to check.

interface LayoutData {
  summary: LayoutSummary;
  byPerson: (LayoutSummary & { name: string })[];
  prints: LayoutPrint[];
  jobsWithoutSizes: number;
}

const m2 = (cm2: number) => fmtNum(cm2ToM2(cm2), 2);
const monthStart = () => todayStr().slice(0, 8) + '01';

export default function DtfLayout({ data, setError }: DtfTabProps) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());
  const [d, setD] = useState<LayoutData | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<LayoutData>(`/dtf/layout?product=${data.product}&from=${from}&to=${to}`)
      .then((r) => live && (setD(r), setError(null)))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the film layout'));
    return () => {
      live = false;
    };
  }, [data.product, from, to, setError]);

  const width = data.settings.layoutWidthCm > 0 ? data.settings.layoutWidthCm : data.settings.rollWidthCm;
  const s = d?.summary;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <p className="note" style={{ margin: 0 }}>
        <b>For information only.</b> How much of the film each print’s artworks fill: the film used (the length measured × the {fmtNum(width)} cm film width) against the total area of the artworks listed (each size × how many). Nothing is
        charged or blocked by it. It is not the roll’s wastage — it is the space between and around the artworks inside the film that was used.
      </p>

      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>From</label>
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>To</label>
          <input className="input" type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {!d && <p className="note">Loading…</p>}
      {d && s && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
            {(
              [
                ['Film used', `${m2(s.filmAreaCm2)} m²`, `${fmtNum(s.metres, 2)} m in ${fmtNum(s.prints)} ${s.prints === 1 ? 'print' : 'prints'}`],
                ['Artworks’ area', `${m2(s.artworkAreaCm2)} m²`, 'the sizes × how many'],
                ['Not filled', `${m2(s.unfilledCm2)} m²`, 'between and around the artworks'],
                ['Film they fill', s.prints > 0 ? `${fmtNum(s.efficiencyPct, 1)}%` : '—', 'artworks’ area ÷ film used'],
              ] as [string, string, string][]
            ).map(([k, v, meta]) => (
              <Card key={k}>
                <div className="card-kicker">{k}</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 30, lineHeight: 1, whiteSpace: 'nowrap', margin: 'var(--space-2) 0' }}>{v}</div>
                <div className="card-meta">{meta}</div>
              </Card>
            ))}
          </div>
          {d.jobsWithoutSizes > 0 && <p className="note" style={{ margin: 0 }}>{d.jobsWithoutSizes} artwork {d.jobsWithoutSizes === 1 ? 'job' : 'jobs'} in these dates have no sizes recorded (earlier ones) and are left out.</p>}

          {d.byPerson.length > 0 && (
            <Card title="By person — who captured the print, highest first">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th style={right}>Prints</th>
                    <th style={right}>Film m</th>
                    <th style={right}>Film m²</th>
                    <th style={right}>Artworks m²</th>
                    <th style={right}>Film they fill</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byPerson.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td style={right}>{fmtNum(p.prints)}</td>
                      <td style={right}>{fmtNum(p.metres, 2)}</td>
                      <td style={right}>{m2(p.filmAreaCm2)}</td>
                      <td style={right}>{m2(p.artworkAreaCm2)}</td>
                      <td style={right}><b>{fmtNum(p.efficiencyPct, 1)}%</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title="Print by print">
            {d.prints.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>No prints with sizes recorded in these dates.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Roll</th>
                      <th>By</th>
                      <th style={right}>Clients</th>
                      <th style={right}>Film m</th>
                      <th style={right}>Film m²</th>
                      <th style={right}>Artworks m²</th>
                      <th style={right}>Not filled m²</th>
                      <th style={right}>Fills</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.prints.map((p) => (
                      <tr key={p.key}>
                        <td>{fmtDate(p.date)}</td>
                        <td>{p.rollId}</td>
                        <td>{p.by || '—'}</td>
                        <td style={right}>{p.clients}</td>
                        <td style={right}>{fmtNum(p.metres, 2)}</td>
                        <td style={right}>{m2(p.filmAreaCm2)}</td>
                        <td style={right}>{m2(p.artworkAreaCm2)}</td>
                        <td style={right}>{p.suspicious ? '—' : m2(p.unfilledCm2)}</td>
                        <td style={right}>
                          {p.suspicious ? <span className="tag tag-outline" style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }}>check the sizes</span> : <b>{fmtNum(p.efficiencyPct, 1)}%</b>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
