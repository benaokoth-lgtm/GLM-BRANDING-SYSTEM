interface Props {
  colSpan: number;
  reason: string;
  setReason: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}

export default function DeleteReasonRow({ colSpan, reason, setReason, onSubmit, onCancel, busy }: Props) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ background: 'var(--color-surface)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
          <div className="field" style={{ margin: 0, flex: 1 }}>
            <label>Reason for deletion</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required" />
          </div>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy}>
            Submit
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
