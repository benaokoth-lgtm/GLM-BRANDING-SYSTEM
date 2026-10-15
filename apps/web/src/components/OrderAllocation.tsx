import { useCallback, useEffect, useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../api/client';

// Under the Staff on an order: correct who the order is credited to (the sales person was forgotten, or the wrong one chosen). Admin and people who manage commission change it with a reason;
// the front office, the sales person it is credited to and whoever keyed it ask, and one of those decides in the Approvals inbox. The order then sits with the right person's orders, and
// their commission and sales target follow it. Everything done is kept as a trail, shown here.

interface Info {
  current: { id: number; name: string };
  people: { id: number; name: string }[];
  direct: boolean;
  canAsk: boolean;
  pending: { id: number; toName: string; requestedByName: string; reason: string; mine: boolean } | null;
  history: { id: number; status: string; fromName: string; toName: string; reason: string; requestedByName: string; decidedByName: string | null; decidedAt: string | null }[];
}

interface Props {
  orderId: number;
  /** Called after the order changed hands, so the screen reads it again. */
  onChanged: () => void;
}

export default function OrderAllocation({ orderId, onChanged }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    api.get<Info>(`/allocation/orders/${orderId}`).then(setInfo).catch(() => setInfo(null));
  }, [orderId]);
  useEffect(load, [load]);

  if (!info) return null;
  const may = info.direct || info.canAsk;

  async function send() {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ applied: boolean; staff?: { name: string } }>(`/allocation/orders/${orderId}`, { staffId: Number(staffId), reason: reason.trim() });
      setOpen(false);
      setStaffId('');
      setReason('');
      setNote(r.applied ? `Now credited to ${r.staff?.name}.` : 'Sent for approval: it takes effect when Admin or a commission manager approves it.');
      load();
      if (r.applied) onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the correction');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontSize: 13 }}>
      {may && !open && !info.pending && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => { setError(''); setNote(''); setOpen(true); }} title="Correct who this order is credited to">
          {info.direct ? 'Change sales person' : 'Ask to change sales person'}
        </button>
      )}
      {info.pending && (
        <div className="note" style={{ margin: 0 }}>
          <span className="tag tag-outline">Waiting for approval</span> Change to <b>{info.pending.toName}</b>, asked by {info.pending.mine ? 'you' : info.pending.requestedByName}: “{info.pending.reason}”
        </div>
      )}
      {note && <div className="note" style={{ margin: 0 }}>{note}</div>}
      {open && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <select className="input" value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="The sales person it should be credited to">
            <option value="">Credit it to…</option>
            {info.people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input className="input" placeholder="Why (for example: sales person forgotten at capture)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Reason for the change" />
          <p className="note" style={{ margin: 0 }}>
            The order moves to their orders, and their commission and sales target follow it. “Captured by” stays as it is.{info.direct ? '' : ' Admin or a commission manager has to approve this.'}
          </p>
          {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !staffId || reason.trim().length < 3} onClick={send}>
              {info.direct ? 'Change' : 'Send for approval'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {info.history.length > 0 && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide' : 'Show'} sales person history ({info.history.length})
          </button>
          {showHistory && (
            <div className="text-muted" style={{ display: 'grid', gap: 2 }}>
              {info.history.map((h) => (
                <div key={h.id}>
                  {h.status === 'Approved' ? `${h.fromName} → ${h.toName}` : `Turned down: ${h.fromName} → ${h.toName}`} · {h.reason} · asked by {h.requestedByName}
                  {h.decidedByName && h.decidedByName !== h.requestedByName ? `, decided by ${h.decidedByName}` : ''}
                  {h.decidedAt ? ` on ${fmtDate(h.decidedAt.slice(0, 10))}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
