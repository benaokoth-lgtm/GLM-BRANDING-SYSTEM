import { useEffect, useState } from 'react';
import { fmtKsh, fmtNum } from '@glm/shared';
import { api } from '../../api/client';

// Reports → GLM vs Sales Persons: how GLM's own sales and the sales persons' compare over the dates chosen above — orders, what was sold (net of VAT), what has been paid and what is still owed, the average
// order and the clients; then by line of business and by month; then each sales person ranked, with what they were paid as a share of what they sold. "GLM's own" is what the front office allocated to
// GLM (the shop); "sales persons'" is what is credited to a sales person.

interface Side {
  orders: number;
  sales: number;
  salesWithVat: number;
  paid: number;
  balance: number;
  avgOrder: number | null;
  clients: number;
  sharePct: number | null;
}
interface Data {
  from: string;
  to: string;
  glm: Side;
  sales: Side;
  heads: { head: string; glm: { orders: number; sales: number }; sales: { orders: number; sales: number } }[];
  months: { month: string; glm: { orders: number; sales: number }; sales: { orders: number; sales: number } }[];
  people: { staffId: number; name: string; orders: number; sales: number; paid: number; avgOrder: number | null; clients: number; sharePct: number | null; paidToThem: number; paidToThemPct: number | null }[];
  legacyFreelancers: { orders: number; sales: number; paid: number };
}

const th = { textAlign: 'right' } as const;

function Block({ title, tone, d }: { title: string; tone: string; d: Side }) {
  return (
    <div className="card blueprint elev-sm" style={{ flex: 1, minWidth: 280, borderTop: `3px solid ${tone}` }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-kicker">{title}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 34, lineHeight: 1.1 }}>{fmtKsh(d.sales)}</div>
      <div className="note" style={{ margin: 0 }}>net of VAT · {d.sharePct == null ? '—' : `${fmtNum(d.sharePct, 1)}%`} of all sales</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px var(--space-3)', margin: 'var(--space-3) 0 0' }}>
        <dt className="text-muted">Orders</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{fmtNum(d.orders)}</dd>
        <dt className="text-muted">Average order</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{d.avgOrder == null ? '—' : fmtKsh(d.avgOrder)}</dd>
        <dt className="text-muted">Clients</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{fmtNum(d.clients)}</dd>
        <dt className="text-muted">Paid so far (VAT incl.)</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{fmtKsh(d.paid)}</dd>
        <dt className="text-muted">Still owed (VAT incl.)</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{fmtKsh(d.balance)}</dd>
      </dl>
    </div>
  );
}

function Bar({ glm, sales }: { glm: number; sales: number }) {
  const total = glm + sales;
  if (total <= 0) return <span className="text-muted">—</span>;
  return (
    <div style={{ display: 'flex', height: 10, minWidth: 120, background: 'var(--color-divider)' }} title={`GLM ${fmtNum((glm / total) * 100, 0)}% · sales persons ${fmtNum((sales / total) * 100, 0)}%`}>
      <div style={{ width: `${(glm / total) * 100}%`, background: 'var(--color-text-muted)' }} />
      <div style={{ width: `${(sales / total) * 100}%`, background: 'var(--color-accent)' }} />
    </div>
  );
}

export default function SalesPerformance({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    api
      .get<Data>(`/reports/sales-performance?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the report'));
  }, [from, to]);

  if (error) return <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>;
  if (!data) return <p className="note">Loading…</p>;
  const empty = data.glm.orders + data.sales.orders === 0;

  return (
    <>
      <p className="note" style={{ margin: 0 }}>
        Orders raised from {data.from} to {data.to} (quotations left out), with the 16% VAT taken out. <b>GLM’s own</b> is what the front office allocated to GLM — the shop; <b>sales persons’</b> is what is credited to a sales person (the one it was
        allocated to, or whose client it is).
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Block title="GLM’s own sales" tone="var(--color-text-muted)" d={data.glm} />
        <Block title="Sales persons’ sales" tone="var(--color-accent)" d={data.sales} />
      </div>
      {empty ? (
        <p className="note">No orders in these dates.</p>
      ) : (
        <>
          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>By line of business</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Line of business</th>
                    <th style={th}>GLM’s own</th>
                    <th style={th}>Sales persons’</th>
                    <th style={th}>Sales persons’ share</th>
                    <th>Split</th>
                  </tr>
                </thead>
                <tbody>
                  {data.heads.map((h) => (
                    <tr key={h.head}>
                      <td>{h.head}</td>
                      <td style={th}>{fmtKsh(h.glm.sales)} <span className="text-muted" style={{ fontSize: 11 }}>· {h.glm.orders}</span></td>
                      <td style={th}>{fmtKsh(h.sales.sales)} <span className="text-muted" style={{ fontSize: 11 }}>· {h.sales.orders}</span></td>
                      <td style={th}>{h.glm.sales + h.sales.sales > 0 ? `${fmtNum((h.sales.sales / (h.glm.sales + h.sales.sales)) * 100, 0)}%` : '—'}</td>
                      <td><Bar glm={h.glm.sales} sales={h.sales.sales} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>Month by month</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th style={th}>GLM’s own</th>
                    <th style={th}>Sales persons’</th>
                    <th>Split</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month}>
                      <td>{m.month}</td>
                      <td style={th}>{fmtKsh(m.glm.sales)} <span className="text-muted" style={{ fontSize: 11 }}>· {m.glm.orders}</span></td>
                      <td style={th}>{fmtKsh(m.sales.sales)} <span className="text-muted" style={{ fontSize: 11 }}>· {m.sales.orders}</span></td>
                      <td><Bar glm={m.glm.sales} sales={m.sales.sales} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>Sales persons ranked</div>
            {data.people.length === 0 && data.legacyFreelancers.orders === 0 ? (
              <p className="note" style={{ margin: 0 }}>No order was credited to a sales person in these dates.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Sales person</th>
                      <th style={th}>Orders</th>
                      <th style={th}>Sales (net)</th>
                      <th style={th}>Share</th>
                      <th style={th}>Average order</th>
                      <th style={th}>Clients</th>
                      <th style={th}>Paid so far</th>
                      <th style={th} title="What they were paid (before tax) for the months of these dates, as a share of what they sold">Paid to them</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map((p, i) => (
                      <tr key={p.staffId}>
                        <td>{i + 1}</td>
                        <td><b>{p.name}</b></td>
                        <td style={th}>{fmtNum(p.orders)}</td>
                        <td style={th}>{fmtKsh(p.sales)}</td>
                        <td style={th}>{p.sharePct == null ? '—' : `${fmtNum(p.sharePct, 1)}%`}</td>
                        <td style={th}>{p.avgOrder == null ? '—' : fmtKsh(p.avgOrder)}</td>
                        <td style={th}>{fmtNum(p.clients)}</td>
                        <td style={th}>{fmtKsh(p.paid)}</td>
                        <td style={th}>{p.paidToThem > 0 ? <>{fmtKsh(p.paidToThem)} <span className="text-muted" style={{ fontSize: 11 }}>· {p.paidToThemPct == null ? '' : `${fmtNum(p.paidToThemPct, 1)}%`}</span></> : <span className="text-muted">—</span>}</td>
                      </tr>
                    ))}
                    {data.legacyFreelancers.orders > 0 && (
                      <tr>
                        <td></td>
                        <td className="text-muted">Old freelance accounts</td>
                        <td style={th}>{fmtNum(data.legacyFreelancers.orders)}</td>
                        <td style={th}>{fmtKsh(data.legacyFreelancers.sales)}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td style={th}>{fmtKsh(data.legacyFreelancers.paid)}</td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
