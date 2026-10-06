import { useRef, useState } from 'react';
import { downloadFile, uploadFile } from '../api/client';

// Download a price list to Excel, edit it there, and upload it again. An uploaded file is checked first — the Admin sees how many lines
// would be added, changed or refused (and why) — and only then applied. Lines are matched on Item + Size; an upload never deletes anything.

interface Check {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: { row: number; message: string }[];
}

export default function PriceListExcel({ kind, onApplied }: { kind: 'services' | 'materials'; onApplied: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [done, setDone] = useState<Check | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const label = kind === 'services' ? 'service' : 'stock';

  async function download() {
    setError('');
    try {
      await downloadFile(`/pricelists/${kind}.xlsx`, `${kind === 'services' ? 'service' : 'stock'}-price-list.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  async function choose(f: File | undefined) {
    if (!f) return;
    setError('');
    setDone(null);
    setCheck(null);
    setFile(f);
    setBusy(true);
    try {
      setCheck(await uploadFile<Check>(`/pricelists/${kind}?dryRun=1`, f));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read');
      setFile(null);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setDone(await uploadFile<Check>(`/pricelists/${kind}`, file));
      setCheck(null);
      setFile(null);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed');
    } finally {
      setBusy(false);
    }
  }

  const cancel = () => {
    setCheck(null);
    setFile(null);
  };

  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>
          Download Excel
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
          Upload Excel
        </button>
        <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => choose(e.target.files?.[0])} />
        <span className="text-muted" style={{ fontSize: 12 }}>
          Download the {label} price list, edit or add rows in Excel, then upload it back. Lines are matched on {kind === 'services' ? 'Service' : 'Item'} + Size; nothing is ever deleted.
        </span>
      </div>

      {error && (
        <p className="note" role="alert" style={{ color: '#a33', fontWeight: 700 }}>
          {error}
        </p>
      )}

      {check && (
        <div className="card" style={{ padding: 'var(--space-3)', marginTop: 'var(--space-2)', maxWidth: 720 }}>
          <strong>{file?.name}</strong> — {check.total} row{check.total === 1 ? '' : 's'} read.
          <div style={{ marginTop: 'var(--space-1)' }}>
            <span className="tag tag-accent">{check.created} new</span> <span className="tag tag-accent">{check.updated} changed</span> <span className="tag tag-neutral">{check.unchanged} unchanged</span>{' '}
            {check.errors.length > 0 && <span className="tag tag-outline" style={{ borderColor: '#a33', color: '#a33' }}>{check.errors.length} not usable</span>}
          </div>
          {check.errors.length > 0 && (
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)', fontSize: 13 }}>
              {check.errors.slice(0, 15).map((e, i) => (
                <li key={i}>
                  Row {e.row}: {e.message}
                </li>
              ))}
              {check.errors.length > 15 && <li>…and {check.errors.length - 15} more</li>}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || check.created + check.updated === 0} onClick={apply}>
              Apply {check.created + check.updated} change{check.created + check.updated === 1 ? '' : 's'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
              Cancel
            </button>
            {check.errors.length > 0 && check.created + check.updated > 0 && <span className="text-muted" style={{ fontSize: 12, alignSelf: 'center' }}>The rows that are not usable are skipped.</span>}
          </div>
        </div>
      )}

      {done && (
        <p className="note" role="status" style={{ fontWeight: 700, borderLeft: '3px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
          Uploaded: {done.created} added, {done.updated} changed, {done.unchanged} unchanged{done.errors.length ? `, ${done.errors.length} skipped` : ''}.
        </p>
      )}
    </div>
  );
}
