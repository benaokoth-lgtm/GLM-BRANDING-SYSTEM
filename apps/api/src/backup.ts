// Backup & restore of every record in the system (users, orders, sales, stock, accounts …) and the optional copy to Google Drive.
//
// A backup is one gzipped JSON file: every table, in the order rows can be re-inserted. Restoring replaces everything in one transaction,
// so a restore that fails halfway leaves the system as it was. The BackupSettings table (schedule, Drive connection) is not part of a
// backup, so restoring never disconnects Drive.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Prisma } from '@prisma/client';
import type { BackupSettings } from '@prisma/client';
import { prisma } from './db';
import { decryptBackup, encryptBackup, isEncryptedBackup, open } from './crypto';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const BACKUP_FORMAT = 'glm-pos-backup';
const EXCLUDED = new Set(['BackupSettings']);
const FILE_PREFIX = 'glm-pos-backup-';
const PRE_RESTORE_PREFIX = 'glm-pos-before-restore-';

// ── The tables, parents before children ──────────────────────────────────────
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

function orderedModels(): DmmfModel[] {
  const models = Prisma.dmmf.datamodel.models.filter((m) => !EXCLUDED.has(m.name));
  const names = new Set(models.map((m) => m.name));
  const dependsOn = (m: DmmfModel) => m.fields.filter((f) => f.relationFromFields && f.relationFromFields.length > 0 && names.has(f.type) && f.type !== m.name).map((f) => f.type);
  const done = new Set<string>();
  const out: DmmfModel[] = [];
  let left = [...models];
  while (left.length) {
    const ready = left.filter((m) => dependsOn(m).every((d) => done.has(d)));
    if (!ready.length) throw new Error(`The tables depend on each other in a circle (${left.map((m) => m.name).join(', ')}) — backups cannot be ordered`);
    for (const m of ready) {
      done.add(m.name);
      out.push(m);
    }
    left = left.filter((m) => !done.has(m.name));
  }
  return out;
}

const delegate = (tx: Prisma.TransactionClient | typeof prisma, model: string) => (tx as any)[model.charAt(0).toLowerCase() + model.slice(1)];
const scalarFields = (m: DmmfModel) => m.fields.filter((f) => f.kind === 'scalar');

// ── Making a backup ──────────────────────────────────────────────────────────
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function buildBackup(): Promise<{ data: Buffer; counts: Record<string, number> }> {
  const tables: BackupFile['tables'] = {};
  const counts: Record<string, number> = {};
  for (const m of orderedModels()) {
    const rows = (await delegate(prisma, m.name).findMany()) as Record<string, unknown>[];
    tables[m.name] = rows;
    counts[m.name] = rows.length;
  }
  const file: BackupFile = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), counts, tables };
  // Encrypted when DATA_KEY is set, so the file is unreadable to anyone who gets hold of it without the key.
  return { data: encryptBackup(await gzip(Buffer.from(JSON.stringify(file), 'utf8'))), counts };
}

export function totalRows(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

// ── Restoring ────────────────────────────────────────────────────────────────
export async function parseBackup(input: Buffer): Promise<BackupFile> {
  const raw = decryptBackup(input); // throws a clear message when the file is encrypted and this server has no (or another) DATA_KEY
  let text: string;
  try {
    text = (raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw).toString('utf8');
  } catch {
    throw new Error('That file is not a backup this system made (it could not be unpacked)');
  }
  let file: BackupFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('That file is not a backup this system made (it is not readable)');
  }
  if (!file || file.format !== BACKUP_FORMAT || typeof file.tables !== 'object' || file.tables === null) throw new Error('That file is not a backup this system made');
  const users = file.tables.User;
  if (!Array.isArray(users) || !users.some((u) => u && u.role === 'Admin')) throw new Error('That backup has no Admin user, so restoring it would lock everyone out — it was not restored');
  return file;
}

function revive(m: DmmfModel, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of scalarFields(m)) {
    const v = row[f.name];
    if (v === undefined) continue; // a column the backup pre-dates: the database default applies
    out[f.name] = f.type === 'DateTime' && typeof v === 'string' ? new Date(v) : v;
  }
  return out;
}

export async function restoreBackup(file: BackupFile): Promise<Record<string, number>> {
  const models = orderedModels();
  const counts: Record<string, number> = {};
  const postgres = /^postgres(ql)?:/i.test(process.env.DATABASE_URL ?? '');
  await prisma.$transaction(
    async (tx) => {
      for (const m of [...models].reverse()) await delegate(tx, m.name).deleteMany();
      for (const m of models) {
        const rows = file.tables[m.name];
        counts[m.name] = 0;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100).map((r) => revive(m, r));
          await delegate(tx, m.name).createMany({ data: chunk });
        }
        counts[m.name] = rows.length;
      }
      if (postgres) {
        // Rows went back with their old ids, so the id counters must move past them or the next new record would clash.
        for (const m of models) {
          const idField = m.fields.find((f) => f.isId && f.name === 'id');
          const d = idField?.default as { name?: string } | undefined;
          if (d && typeof d === 'object' && d.name === 'autoincrement') {
            await tx.$queryRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${m.name}"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${m.name}"), 1), (SELECT COUNT(*) > 0 FROM "${m.name}"))`);
          }
        }
      }
    },
    { timeout: 10 * 60_000, maxWait: 60_000 },
  );
  return counts;
}

// ── Files kept on this server ────────────────────────────────────────────────
export function backupDir(): string {
  return path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function saveLocal(data: Buffer, prefix = FILE_PREFIX): string {
  fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
  const ext = isEncryptedBackup(data) ? '.json.gz.enc' : '.json.gz';
  let name = `${prefix}${stamp()}${ext}`;
  for (let n = 2; fs.existsSync(path.join(backupDir(), name)); n++) name = `${prefix}${stamp()}-${n}${ext}`;
  fs.writeFileSync(path.join(backupDir(), name), data, { mode: 0o600 });
  return name;
}

export interface LocalBackup {
  name: string;
  size: number;
  modified: string;
  beforeRestore: boolean;
}

export function listLocal(): LocalBackup[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^[\w.-]+\.json\.gz(\.enc)?$/.test(n) && (n.startsWith(FILE_PREFIX) || n.startsWith(PRE_RESTORE_PREFIX)))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, modified: st.mtime.toISOString(), beforeRestore: name.startsWith(PRE_RESTORE_PREFIX) };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name));
}

export function readLocal(name: string): Buffer | null {
  if (!/^[\w.-]+\.json\.gz(\.enc)?$/.test(name)) return null;
  const file = path.join(backupDir(), name);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/** Keeps the newest `keep` scheduled/manual backups and the last few made just before a restore. */
function pruneLocal(keep: number) {
  const files = listLocal();
  for (const f of files.filter((x) => !x.beforeRestore).slice(keep)) fs.rmSync(path.join(backupDir(), f.name), { force: true });
  for (const f of files.filter((x) => x.beforeRestore).slice(3)) fs.rmSync(path.join(backupDir(), f.name), { force: true });
}

/** A copy of the system as it is now, kept on the server just before a restore replaces it. */
export async function saveBeforeRestore(): Promise<string> {
  const { data } = await buildBackup();
  const name = saveLocal(data, PRE_RESTORE_PREFIX);
  pruneLocal(Number.MAX_SAFE_INTEGER);
  return name;
}

// ── Settings ─────────────────────────────────────────────────────────────────
export async function getBackupSettings(): Promise<BackupSettings> {
  const row = await prisma.backupSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  // The Drive secret and token are kept sealed in the database (when DATA_KEY is set); everything that uses them gets them opened.
  const safeOpen = (v: string) => {
    try {
      return open(v);
    } catch {
      return '';
    }
  };
  return { ...row, driveClientSecret: safeOpen(row.driveClientSecret), driveRefreshToken: safeOpen(row.driveRefreshToken) };
}

// ── Google Drive ─────────────────────────────────────────────────────────────
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
// drive.file: the app can only see files it created itself — never the rest of the Admin's Drive.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'GLM POS Backups';

export function googleAuthUrl(s: BackupSettings, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: s.driveClientId, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state });
  return `${GOOGLE_AUTH}?${q}`;
}

async function googleJson(res: Response): Promise<any> {
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error_description || body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || `Google answered ${res.status}`);
  return body;
}

export async function exchangeGoogleCode(s: BackupSettings, code: string): Promise<string> {
  const body = new URLSearchParams({ code, client_id: s.driveClientId, client_secret: s.driveClientSecret, redirect_uri: s.oauthRedirectUri, grant_type: 'authorization_code' });
  const t = await googleJson(await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }));
  if (!t.refresh_token) throw new Error('Google did not hand back a long-lived permission. Remove this app under your Google account → Security → Third-party access, then connect again.');
  return t.refresh_token as string;
}

async function accessToken(s: BackupSettings): Promise<string> {
  const body = new URLSearchParams({ client_id: s.driveClientId, client_secret: s.driveClientSecret, refresh_token: s.driveRefreshToken, grant_type: 'refresh_token' });
  const t = await googleJson(await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }));
  return t.access_token as string;
}

export async function revokeGoogle(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
}

async function ensureFolder(token: string, s: BackupSettings): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  if (s.driveFolderId) {
    const r = await fetch(`${DRIVE}/files/${encodeURIComponent(s.driveFolderId)}?fields=id,trashed`, { headers: auth });
    if (r.ok) {
      const f: any = await r.json();
      if (!f.trashed) return s.driveFolderId;
    }
  }
  const f = await googleJson(await fetch(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) }));
  await prisma.backupSettings.update({ where: { id: 1 }, data: { driveFolderId: f.id } });
  return f.id as string;
}

/** Creates the Drive folder right after connecting, so the Admin can see it straight away. */
export async function prepareDrive(): Promise<void> {
  const s = await getBackupSettings();
  await ensureFolder(await accessToken(s), s);
}

async function uploadToDrive(s: BackupSettings, name: string, data: Buffer): Promise<void> {
  const token = await accessToken(s);
  const folderId = await ensureFolder(token, s);
  const boundary = `glm${Date.now().toString(16)}`;
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${isEncryptedBackup(data) ? 'application/octet-stream' : 'application/gzip'}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  await googleJson(await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }));
  // Keep only the newest `keepCount` backups in the folder.
  const q = new URLSearchParams({ q: `'${folderId}' in parents and trashed = false and name contains '${FILE_PREFIX}'`, orderBy: 'createdTime desc', pageSize: '1000', fields: 'files(id)' });
  const list = await googleJson(await fetch(`${DRIVE}/files?${q}`, { headers: { Authorization: `Bearer ${token}` } }));
  for (const f of (list.files ?? []).slice(s.keepCount)) await fetch(`${DRIVE}/files/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
}

export const driveConnected = (s: BackupSettings) => !!(s.driveRefreshToken && s.driveClientId && s.driveClientSecret);

// ── Running a backup (by hand or on schedule) ────────────────────────────────
let running = false;

export interface RunOutcome {
  ok: boolean;
  file: string;
  rows: number;
  drive: 'uploaded' | 'not connected' | 'failed';
  error: string;
}

export async function runBackup(trigger: 'manual' | 'scheduled'): Promise<RunOutcome> {
  if (running) throw new Error('A backup is already running');
  running = true;
  const attemptedAt = new Date();
  let outcome: RunOutcome = { ok: false, file: '', rows: 0, drive: 'not connected', error: '' };
  try {
    const s = await getBackupSettings();
    const { data, counts } = await buildBackup();
    const file = saveLocal(data);
    pruneLocal(s.keepCount);
    outcome = { ok: true, file, rows: totalRows(counts), drive: 'not connected', error: '' };
    if (driveConnected(s)) {
      try {
        await uploadToDrive(s, file, data);
        outcome.drive = 'uploaded';
      } catch (err) {
        outcome.drive = 'failed';
        outcome.error = `Saved on the server, but the copy to Google Drive failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
  } finally {
    running = false;
  }
  const good = outcome.ok && outcome.drive !== 'failed';
  await prisma.backupSettings.update({
    where: { id: 1 },
    data: {
      lastAttemptAt: attemptedAt,
      ...(outcome.ok ? { lastRunAt: attemptedAt, lastDriveFile: outcome.drive === 'uploaded' ? outcome.file : '' } : {}),
      lastStatus: good ? `${trigger === 'scheduled' ? 'Scheduled' : 'Manual'} backup OK${outcome.drive === 'uploaded' ? ' · copied to Google Drive' : ''}` : `${trigger === 'scheduled' ? 'Scheduled' : 'Manual'} backup had a problem`,
      lastError: outcome.error,
    },
  });
  return outcome;
}

// ── The schedule ─────────────────────────────────────────────────────────────
/** Is a scheduled backup due? After a failure it tries again within the hour rather than waiting out the whole interval. */
export function isDue(s: BackupSettings, now = new Date()): boolean {
  if (!s.enabled) return false;
  if (!s.lastAttemptAt) return true;
  const sinceAttempt = now.getTime() - s.lastAttemptAt.getTime();
  const failed = !!s.lastError;
  const wait = failed ? Math.min(s.intervalHours, 1) * 3_600_000 : s.intervalHours * 3_600_000;
  return sinceAttempt >= wait;
}

export function startBackupScheduler(): void {
  const tick = async () => {
    try {
      if (isDue(await getBackupSettings())) await runBackup('scheduled');
    } catch (err) {
      console.error('Scheduled backup failed', err);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
