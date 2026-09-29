import { useState } from 'react';
import { fmtDate, fmtNum, saleTotals } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, right } from './shared';
import type { DtfTabProps } from './shared';

// History/management view only — recording a new sale now happens on its
// own page (New Film Order, next to New Walk-in Order in the top nav; see
// pages/NewFilmOrder.tsx) so Staff with just canAccessDtf can reach it
// without seeing roll costs or Setup. This tab (canManageDtf only, see
// Dtf.tsx) is where a manager reconciles payment and removes bad entries.
export default function DtfSales({ data, reload, setError }: DtfTabProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Film sales">
      {data.sales.length === 0 ? (
        <p className="note">No sales yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th>Date</th><th>Roll</th><th>Client</th>
                <th style={right}>Metres</th><th style={right}>Price/m</th><th style={right}>Disc/m</th>
                <th style={right}>Total</th><th style={right}>Paid</th><th style={right}>Balance</th>
                {data.canManage && <th className="no-print"></th>}
              </tr>
            </thead>
            <tbody>
              {data.sales.map((x) => {
                const t = saleTotals(x);
                return (
                  <tr key={x.id}>
                    <td className="text-muted">{fmtDate(x.soldOn)}</td>
                    <td>{x.rollId}</td>
                    <td>{x.client || '—'}</td>
                    <td style={right}>{fmtNum(x.metres, 2)}</td>
                    <td style={right}>{fmtNum(x.pricePerM)}</td>
                    <td style={right}>{fmtNum(t.discountPerM)}</td>
                    <td style={{ ...right, fontWeight: 700 }}>{fmtNum(t.total)}</td>
                    <td style={right}>{fmtNum(x.amountPaid)}</td>
                    <td style={right}>{fmtNum(t.balance)}</td>
                    {data.canManage && (
                      <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                        {t.balance > 0 && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/dtf/sales/${x.id}/paid`, { amountPaid: t.total }))}>
                            Mark paid
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => window.confirm(`Delete this sale (${x.rollId}, ${fmtNum(x.metres, 2)} m)?`) && act(() => api.del(`/dtf/sales/${x.id}`))}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
