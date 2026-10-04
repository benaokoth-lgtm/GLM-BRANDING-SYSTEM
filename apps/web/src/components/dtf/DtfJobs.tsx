import { fmtDate, fmtNum, jobTotals, systemJobCalc } from '@glm/shared';
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
                <th style={right}>Recommended/pc</th><th style={right}>Final/pc</th><th style={right}>vs recommended</th><th style={right}>Total</th><th>Status</th>
                {isAdmin && <th className="no-print"></th>}
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((x) => {
                const t = jobTotals(x);
                const sys = systemJobCalc(x).finalPerPiece;
                const diff = Math.round((t.finalPerPiece - sys) * 100) / 100;
                return (
                  <tr key={x.id}>
                    <td className="text-muted">{fmtDate(x.jobOn)}</td>
                    <td>{x.rollId}</td>
                    <td>{x.client || '—'}</td>
                    <td style={right}>{fmtNum(x.runningMetres, 2)}</td>
                    <td style={right}>{x.pieces}</td>
                    <td style={right}>{fmtNum(sys, 2)}</td>
                    <td style={right}>{fmtNum(t.finalPerPiece, 2)}</td>
                    <td style={{ ...right, color: diff < 0 ? '#a33' : undefined, fontWeight: diff !== 0 ? 700 : undefined }}>{diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${fmtNum(diff, 2)}`}</td>
                    <td style={{ ...right, fontWeight: 700 }}>{fmtNum(t.jobTotal)}</td>
                    <td>{x.approvalStatus === 'Pending' ? <span className="tag tag-outline">Awaiting approval</span> : diff < 0 ? <span className="tag tag-neutral">Approved discount</span> : ''}</td>
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
