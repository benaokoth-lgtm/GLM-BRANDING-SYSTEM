import { useEffect, useRef, useState } from 'react';
import { api, apiAbsoluteUrl, downloadFile, uploadFile } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → Backup & Restore (Admin): a copy of every record in the system — users, orders, sales, stock, accounts — that can be
// downloaded, kept on the server on a schedule, copied to the Admin's Google Drive, and restored.

interface BackupFileRow {
  name: string;
  size: number;
  modified: string;
  beforeRestore: boolean;
}
interface Status {
  enabled: boolean;
  intervalHours: number;
  keepCount: number;
  driveClientId: string;
  hasDriveClientSecret: boolean;
  driveConnected: boolean;
  driveConnectedAt: string | null;
  lastRunAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: string;
  lastError: string;
  folder: string;
  /** True when the server has a DATA_KEY: backup files are encrypted. */
  encrypted: boolean;
  files: BackupFileRow[];
}
interface RestoreCheck {
  createdAt: string;
  rows: number;
  counts: Record<string, number>;
}

const INTERVALS: [number, string][] = [
  [6, 'Every 6 hours'],
  [12, 'Every 12 hours'],
  [24, 'Every day'],
  [48, 'Every 2 days'],
  [168, 'Every week'],
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function BackupPanel() {
  const { data, error, loading, reload } = useLoad<Status>('/backup/status');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalHours] = useState(24);
  const [keep, setKeep] = useState('14');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loaded, setLoaded] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreName, setRestoreName] = useState(''); // a backup kept on the server
  const [restoreCheck, setRestoreCheck] = useState<RestoreCheck | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restored, setRestored] = useState(false);

  // Coming back from Google's sign-in: the API sends the browser here with ?backup=connected (or a reason it failed).
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('backup');
    if (!result) return;
    url.searchParams.delete('backup');
    window.history.replaceState({}, '', url.pathname + url.search);
    if (result === 'connected') setMsg('Google Drive is connected. Backups will now be copied to the "GLM POS Backups" folder in your Drive.');
    else setErr(result);
  }, []);

  useEffect(() => {
    if (data && !loaded) {
      setEnabled(data.enabled);
      setIntervalHours(data.intervalHours);
      setKeep(String(data.keepCount));
      setClientId(data.driveClientId);
      setLoaded(true);
    }
  }, [data, loaded]);

  if (!data) return <Loading loading={loading} error={error} />;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  };

  const saveSettings = (extra: Record<string, unknown> = {}) =>
    run('settings', async () => {
      const k = Number(keep);
      if (!(k >= 1)) throw new Error('Keep at least 1 backup');
      await api.put('/backup/settings', { enabled, intervalHours: interval, keepCount: k, driveClientId: clientId, ...(clientSecret ? { driveClientSecret: clientSecret } : {}), ...extra });
      setClientSecret('');
      setMsg('Saved.');
      reload();
    });

  const backupNow = () =>
    run('now', async () => {
      const r = await api.post<{ ok: boolean; file: string; rows: number; drive: string; error: string }>('/backup/run');
      if (!r.ok) throw new Error(r.error || 'The backup failed');
      setMsg(`Backup made (${r.rows.toLocaleString()} records)${r.drive === 'uploaded' ? ' and copied to Google Drive' : r.drive === 'failed' ? '' : ' — kept on the server'}.`);
      if (r.error) setErr(r.error);
      reload();
    });

  const connect = () =>
    run('connect', async () => {
      await api.put('/backup/settings', { driveClientId: clientId, ...(clientSecret ? { driveClientSecret: clientSecret } : {}) });
      const r = await api.post<{ url: string }>('/backup/google/connect', { redirectUri: apiAbsoluteUrl('/backup/google/callback'), returnUrl: `${window.location.origin}/master-data` });
      window.location.href = r.url;
    });

  const disconnect = () =>
    run('disconnect', async () => {
      await api.post('/backup/google/disconnect');
      setMsg('Google Drive is disconnected. Files already in your Drive stay there.');
      reload();
    });

  async function chooseRestoreFile(f: File | undefined) {
    if (!f) return;
    setRestored(false);
    setConfirmText('');
    setRestoreName('');
    setRestoreFile(f);
    setRestoreCheck(null);
    await run('check', async () => {
      try {
        setRestoreCheck(await uploadFile<RestoreCheck>('/backup/restore?check=1', f));
      } catch (e) {
        setRestoreFile(null);
        throw e;
      }
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  async function chooseServerFile(name: string) {
    setRestored(false);
    setConfirmText('');
    setRestoreFile(null);
    setRestoreName(name);
    setRestoreCheck(null);
    await run('check', async () => {
      try {
        const res = await api.post<RestoreCheck>(`/backup/restore?check=1&file=${encodeURIComponent(name)}`);
        setRestoreCheck(res);
      } catch (e) {
        setRestoreName('');
        throw e;
      }
    });
  }

  const doRestore = () =>
    run('restore', async () => {
      if (confirmText !== 'RESTORE') throw new Error('Type RESTORE to confirm');
      const r = restoreFile
        ? await uploadFile<{ rows: number; savedBefore: string }>('/backup/restore?confirm=RESTORE', restoreFile)
        : await api.post<{ rows: number; savedBefore: string }>(`/backup/restore?confirm=RESTORE&file=${encodeURIComponent(restoreName)}`);
      setRestored(true);
      setRestoreCheck(null);
      setRestoreFile(null);
      setRestoreName('');
      setConfirmText('');
      setMsg(`Restored ${r.rows.toLocaleString()} records. The system as it was a moment ago was kept on the server as ${r.savedBefore}.`);
      reload();
    });

  const redirectUri = apiAbsoluteUrl('/backup/google/callback');
  const healthy = !!data.lastRunAt && !data.lastError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 900 }}>
      <Notice error={err || error} message={msg} />

      <Card
        title="Backup"
        hint="A backup holds every record in the system: users and roles, orders, sales, payments, stock, accounts, settings and price lists. Keep copies somewhere other than this server."
        actions={<Tag tone={healthy ? 'good' : data.lastError ? 'bad' : 'neutral'}>{data.lastError ? 'Needs attention' : data.lastRunAt ? 'Backed up' : 'No backup yet'}</Tag>}
      >
        <table className="table">
          <tbody>
            <tr>
              <td className="text-muted" style={{ width: 190 }}>
                Last backup
              </td>
              <td>
                {when(data.lastRunAt)}
                {data.lastStatus && <span className="text-muted"> · {data.lastStatus}</span>}
              </td>
            </tr>
            {data.lastError && (
              <tr>
                <td className="text-muted">Problem</td>
                <td style={{ color: '#a33' }}>{data.lastError}</td>
              </tr>
            )}
            <tr>
              <td className="text-muted">Encryption</td>
              <td>
                {data.encrypted ? (
                  <Tag tone="good">Backup files are encrypted</Tag>
                ) : (
                  <>
                    <Tag tone="bad">Not encrypted</Tag> <span className="text-muted">Anyone with a copy of a backup file can read it. Set up the data key — see the Security tab.</span>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td className="text-muted">Kept on the server in</td>
              <td>
                <code>{data.folder}</code>
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={backupNow}>
            {busy === 'now' ? 'Backing up…' : 'Back up now'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => run('download', () => downloadFile('/backup/download', 'glm-pos-backup.json.gz'))}>
            Download a backup
          </button>
        </div>
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <b>Back up now</b> saves a copy on the server{data.driveConnected ? ' and in your Google Drive' : ''}. <b>Download a backup</b> gives you the file to keep yourself. A backup file contains PIN hashes and settings — keep it private.
        </p>
      </Card>

      <Card title="Automatic backups" hint="The system makes a backup by itself on this schedule and keeps the newest ones.">
        <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', fontWeight: 700 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Back up automatically
          </label>
          <div className="field" style={{ margin: 0 }}>
            <label>How often</label>
            <select className="input" value={interval} onChange={(e) => setIntervalHours(Number(e.target.value))}>
              {INTERVALS.map(([h, l]) => (
                <option key={h} value={h}>
                  {l}
                </option>
              ))}
              {!INTERVALS.some(([h]) => h === interval) && <option value={interval}>Every {interval} hours</option>}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Keep the newest</label>
            <input className="input" style={{ width: 90 }} inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value)} />
          </div>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => saveSettings()}>
            Save schedule
          </button>
        </div>
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          {data.enabled ? `Next backup is due ${data.lastAttemptAt ? 'about ' + when(new Date(new Date(data.lastAttemptAt).getTime() + (data.lastError ? Math.min(data.intervalHours, 1) : data.intervalHours) * 3_600_000).toISOString()) : 'within minutes'}.` : 'Automatic backups are off.'} Older backups beyond the number kept are removed from the server and from Google Drive.
        </p>
      </Card>

      <Card
        title="Google Drive"
        hint="Copies every backup into a “GLM POS Backups” folder in your own Google Drive. The system can only see files it put there — never the rest of your Drive."
        actions={<Tag tone={data.driveConnected ? 'good' : 'neutral'}>{data.driveConnected ? 'Connected' : 'Not connected'}</Tag>}
      >
        {data.driveConnected ? (
          <>
            <p style={{ marginTop: 0 }}>
              Connected {data.driveConnectedAt ? `on ${when(data.driveConnectedAt)}` : ''}. Every backup — automatic or by hand — is copied to your Drive.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={disconnect}>
              Disconnect Google Drive
            </button>
          </>
        ) : (
          <>
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>One-time setup in Google (about 5 minutes)</summary>
              <ol style={{ lineHeight: 1.6, paddingLeft: 'var(--space-4)' }}>
                <li>
                  Open <b>console.cloud.google.com</b>, create a project (any name), then <b>APIs &amp; Services → Library</b> and enable <b>Google Drive API</b>.
                </li>
                <li>
                  <b>APIs &amp; Services → OAuth consent screen</b>: choose <i>External</i>, give it a name, add your own email as a <i>Test user</i>, and save. (Leave it in “Testing”.)
                </li>
                <li>
                  <b>Credentials → Create credentials → OAuth client ID</b>, type <i>Web application</i>. Under <b>Authorized redirect URIs</b> add exactly:
                  <br />
                  <code style={{ userSelect: 'all' }}>{redirectUri}</code>
                </li>
                <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below, press <b>Save and connect</b>, and approve access with your Google account.</li>
              </ol>
              <p className="note">While the Google app is in “Testing”, Google asks you to reconnect about every 7 days. To avoid that, set the consent screen to “In production” (no Google review is needed for your own use).</p>
            </details>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Client ID</label>
                <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="….apps.googleusercontent.com" autoComplete="off" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Client secret</label>
                <input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={data.hasDriveClientSecret ? 'Saved — type to replace' : ''} autoComplete="new-password" />
              </div>
            </div>
            <div style={{ marginTop: 'var(--space-3)' }}>
              <button type="button" className="btn btn-primary" disabled={!!busy || !clientId.trim() || (!clientSecret && !data.hasDriveClientSecret)} onClick={connect}>
                {busy === 'connect' ? 'Opening Google…' : 'Save and connect Google Drive'}
              </button>
            </div>
          </>
        )}
      </Card>

      <Card title="Backups on the server" hint="Newest first. Download one to keep it, or restore the system to it.">
        {data.files.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>
            None yet — press <b>Back up now</b>.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Made</th>
                <th style={{ textAlign: 'right' }}>Size</th>
                <th style={{ width: 190 }}></th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.name}>
                  <td>
                    <code style={{ fontSize: 12 }}>{f.name}</code> {f.beforeRestore && <span className="tag tag-neutral">before a restore</span>}
                  </td>
                  <td>{when(f.modified)}</td>
                  <td style={{ textAlign: 'right' }}>{kb(f.size)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => run('download', () => downloadFile(`/backup/files/${encodeURIComponent(f.name)}`, f.name))}>
                      Download
                    </button>{' '}
                    <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => chooseServerFile(f.name)}>
                      Restore…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Restore" hint="Replaces everything in the system with the contents of a backup. Use it to move to a new server or to undo a disaster.">
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}>
            Choose a backup file…
          </button>
          <input ref={fileInput} type="file" accept=".gz,.enc,.json,application/gzip" hidden onChange={(e) => chooseRestoreFile(e.target.files?.[0])} />
          <span className="text-muted" style={{ fontSize: 12 }}>A file made by “Download a backup” or one from your Google Drive folder.</span>
        </div>

        {restoreCheck && (
          <div className="card" style={{ padding: 'var(--space-3)', marginTop: 'var(--space-3)', borderColor: '#a33' }}>
            <strong>{restoreFile?.name ?? restoreName}</strong> — made {when(restoreCheck.createdAt)}, {restoreCheck.rows.toLocaleString()} records ({restoreCheck.counts.Order ?? 0} orders, {restoreCheck.counts.User ?? 0} users, {restoreCheck.counts.Service ?? 0} services, {restoreCheck.counts.Material ?? 0} stock items).
            <p style={{ color: '#a33', fontWeight: 700, margin: 'var(--space-2) 0' }}>
              Restoring replaces everything in the system right now with this backup. Anything entered since it was made is lost. A copy of the system as it is now is saved on the server first. Everyone will be signed out.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Type RESTORE to confirm</label>
                <input className="input" style={{ width: 160 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
              </div>
              <button type="button" className="btn btn-primary" disabled={!!busy || confirmText !== 'RESTORE'} onClick={doRestore}>
                {busy === 'restore' ? 'Restoring…' : 'Restore this backup'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRestoreCheck(null);
                  setRestoreFile(null);
                  setRestoreName('');
                  setConfirmText('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {restored && (
          <p style={{ marginTop: 'var(--space-3)' }}>
            <button type="button" className="btn btn-primary" onClick={() => (window.location.href = '/login')}>
              Go to sign-in
            </button>
          </p>
        )}
      </Card>
    </div>
  );
}
