import { fmtDate, fmtNum, jobTotals } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, right } from './shared';
import type { DtfTabProps } from './shared';

// History/management view only — recording a new job now happens on its own
// page (New Artwork Order, next to New Walk-in Order in the top nav; see
// pages/NewArtworkOrder.tsx). This tab (canManageDtf only, see Dtf.tsx) is
// where a manager removes a bad entry.
export default function DtfJobs({ data, reload, setError }: DtfTabProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';

  async function del(id: DtfTabProps['data']['jobs'][number]['id'], label: string) {
    if (!window.confirm(`Delete this job (${label})?`)) return;
    setError(null);
    try {
      await api.del(`/dtf/jobs/${id}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <Card title="Artwork jobs">
      {data.jobs.length === 0 ? (
        <p className="note">No jobs yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th>Date</th><th>Roll</th><th>Client</th>
                <th style={right}>Run m</th><th style={right}>Pcs</th>
                <th style={right}>Final/pc</th><th style={right}>Total</th>
                {isAdmin && <th className="no-print"></th>}
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((x) => {
                const t = jobTotals(x);
                return (
                  <tr key={x.id}>
                    <td className="text-muted">{fmtDate(x.jobOn)}</td>
                    <td>{x.rollId}</td>
                    <td>{x.client || '—'}</td>
                    <td style={right}>{fmtNum(x.runningMetres, 2)}</td>
                    <td style={right}>{x.pieces}</td>
                    <td style={right}>{fmtNum(t.finalPerPiece)}</td>
                    <td style={{ ...right, fontWeight: 700 }}>{fmtNum(t.jobTotal)}</td>
                    {isAdmin && (
                      <td className="no-print">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => del(x.id, `${x.rollId}, ${fmtNum(x.runningMetres, 2)} m`)}>
                          Delete
                        </button>
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
