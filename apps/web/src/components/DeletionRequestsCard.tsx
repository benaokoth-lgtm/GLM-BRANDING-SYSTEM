import { fmtDate } from '@glm/shared';
import type { DeletionRequest } from '../api/models';

interface Props {
  title: string;
  requests: DeletionRequest[];
  onDecide: (id: number, approve: boolean) => void;
  busy: boolean;
}

export default function DeletionRequestsCard({ title, requests, onDecide, busy }: Props) {
  const pendingCount = requests.filter((r) => r.status === 'Pending').length;
  return (
    <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
        {title} {pendingCount > 0 && <span className="tag tag-accent">{pendingCount} pending</span>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Requested</th>
            <th>Record</th>
            <th>Reason</th>
            <th>Requested by</th>
            <th>Status</th>
            <th className="no-print"></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className="text-muted">{fmtDate(r.requestedAt.slice(0, 10))}</td>
              <td>{r.summary}</td>
              <td className="text-muted">{r.reason}</td>
              <td className="text-muted">{r.requestedByName}</td>
              <td>
                <span className={r.status === 'Approved' ? 'tag tag-accent' : r.status === 'Rejected' ? 'tag tag-neutral' : 'tag tag-outline'}>{r.status}</span>
              </td>
              <td className="no-print">
                {r.status === 'Pending' && (
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => onDecide(r.id, true)} disabled={busy}>
                      Approve
                    </button>
                    <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => onDecide(r.id, false)} disabled={busy}>
                      Reject
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests.length === 0 && <p className="note">No deletion requests.</p>}
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        You can't approve or reject your own deletion request — a different finance manager/general manager/admin must
        review it.
      </p>
    </div>
  );
}
