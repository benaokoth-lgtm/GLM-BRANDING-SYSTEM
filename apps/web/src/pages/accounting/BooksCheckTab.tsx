import { Card, DateRangeBar, Loading, Tag, money, numStyle, useLoad } from './shared';
import type { Range } from './shared';

interface Recon {
  sources: { source: string; label: string; side: string; records: number; expected: number; posted: number; difference: number }[];
  issues: { source: string; ref: string; expected: number; posted: number; problem: string }[];
  integrity: { name: string; ok: boolean; detail: string }[];
  catchAll: { kind: string; ref: string; head: string; amount: number; account: string }[];
  notInBooks: { label: string; amount: number; count: number; note: string }[];
  allPosted: boolean;
}

// "Books check": does every sale, payment, expense and wage reach the books for the right amount, and do the books hang
// together (debits = credits, receivables and payables agree with their ageing, petty cash never overdrawn…)?
export function BooksCheckTab({ range }: { range: Range }) {
  const { data, error, loading } = useLoad<Recon>(`/accounting/reconcile?from=${range.from}&to=${range.to}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <DateRangeBar range={range} />
      <Loading loading={loading} error={error} />
      {data && (
        <>
          <Card
            title="Books check"
            hint="Each record is re-worked from the record itself and compared with what the ledger posted. Anything that doesn't match, or can't be right, is listed here."
            actions={<Tag tone={data.allPosted ? 'good' : 'bad'}>{data.allPosted ? 'All good' : 'Needs attention'}</Tag>}
          >
            <table className="table">
              <tbody>
                {data.integrity.map((c) => (
                  <tr key={c.name}>
                    <td style={{ width: 90 }}>
                      <Tag tone={c.ok ? 'good' : 'bad'}>{c.ok ? 'OK' : 'Check'}</Tag>
                    </td>
                    <td>{c.name}</td>
                    <td className="text-muted">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Records vs the books" hint="Expected comes from the record itself; posted is what reached the ledger. The difference should be nil.">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th style={numStyle}>Records</th>
                  <th style={numStyle}>Expected</th>
                  <th style={numStyle}>Posted</th>
                  <th style={numStyle}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.source}>
                    <td>{s.label}</td>
                    <td style={numStyle}>{s.records}</td>
                    <td style={numStyle}>{money(s.expected)}</td>
                    <td style={numStyle}>{money(s.posted)}</td>
                    <td style={{ ...numStyle, color: Math.abs(s.difference) > 0.02 ? 'var(--color-error)' : undefined, fontWeight: Math.abs(s.difference) > 0.02 ? 700 : undefined }}>{Math.abs(s.difference) > 0.02 ? money(s.difference) : '✓'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {data.issues.length > 0 && (
            <Card title="Records that don't match">
              <table className="table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Reference</th>
                    <th style={numStyle}>Expected</th>
                    <th style={numStyle}>Posted</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {data.issues.map((i, n) => (
                    <tr key={n}>
                      <td>{i.source}</td>
                      <td>{i.ref}</td>
                      <td style={numStyle}>{money(i.expected)}</td>
                      <td style={numStyle}>{money(i.posted)}</td>
                      <td style={{ color: 'var(--color-error)' }}>{i.problem}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {data.catchAll.length > 0 && (
            <Card title="Booked to a catch-all account" hint="These expenses use a head with no account, so they went to Uncategorised. Link the head to an account under Chart of Accounts.">
              <table className="table">
                <tbody>
                  {data.catchAll.map((c, n) => (
                    <tr key={n}>
                      <td>{c.ref}</td>
                      <td>{c.head}</td>
                      <td style={numStyle}>{money(c.amount)}</td>
                      <td className="text-muted">{c.account}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {data.notInBooks.some((n) => n.count > 0) && (
            <Card title="Not (fully) in the books" hint="Records that exist but don't post automatically — worth a look.">
              <table className="table">
                <tbody>
                  {data.notInBooks
                    .filter((n) => n.count > 0)
                    .map((n) => (
                      <tr key={n.label}>
                        <td>
                          <strong>{n.label}</strong>
                          <div className="note">{n.note}</div>
                        </td>
                        <td style={numStyle}>{n.count}</td>
                        <td style={numStyle}>{n.amount ? money(n.amount) : ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
