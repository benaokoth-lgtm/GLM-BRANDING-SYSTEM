// Master Data → Backup & Restore (Admin only): download or restore a backup of all system data, the schedule, and the Google Drive connection.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { dataKeyConfigured, isEncryptedBackup, seal } from '../crypto';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  backupDir,
  buildBackup,
  driveConnected,
  exchangeGoogleCode,
  getBackupSettings,
  googleAuthUrl,
  listLocal,
  parseBackup,
  prepareDrive,
  readLocal,
  restoreBackup,
  revokeGoogle,
  runBackup,
  saveBeforeRestore,
  totalRows,
} from '../backup';

export const backupRouter = Router();

const admin = [requireAuth, requireRole('Admin')];
const rawBody = express.raw({ type: () => true, limit: '200mb' });
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// Everything the Backup tab shows. The Drive client secret and token are never sent back — only whether they are set.
backupRouter.get('/status', ...admin, async (_req, res) => {
  const s = await getBackupSettings();
  res.json({
    enabled: s.enabled,
    intervalHours: s.intervalHours,
    keepCount: s.keepCount,
    driveClientId: s.driveClientId,
    hasDriveClientSecret: !!s.driveClientSecret,
    driveConnected: driveConnected(s),
    driveConnectedAt: s.driveConnectedAt,
    driveFolderId: s.driveFolderId,
    lastRunAt: s.lastRunAt,
    lastAttemptAt: s.lastAttemptAt,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    folder: backupDir(),
    encrypted: dataKeyConfigured(),
    files: listLocal(),
  });
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(24 * 31).optional(),
  keepCount: z.number().int().min(1).max(365).optional(),
  driveClientId: z.string().trim().max(300).optional(),
  // Only replaced when something is typed — the saved one is never shown.
  driveClientSecret: z.string().trim().max(300).optional(),
});

backupRouter.put('/settings', ...admin, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { driveClientSecret, ...rest } = parsed.data;
  const current = await getBackupSettings();
  const data: Record<string, unknown> = { ...rest };
  if (driveClientSecret) data.driveClientSecret = seal(driveClientSecret);
  // A different Google client means the old permission no longer applies.
  if (rest.driveClientId !== undefined && rest.driveClientId !== current.driveClientId && current.driveRefreshToken) {
    data.driveRefreshToken = '';
    data.driveFolderId = '';
    data.driveConnectedAt = null;
  }
  // Turning the schedule on starts it now rather than after one full interval.
  if (rest.enabled === true && !current.enabled) data.lastAttemptAt = null;
  await prisma.backupSettings.update({ where: { id: 1 }, data });
  res.json({ ok: true });
});

// ── Back up now / download ───────────────────────────────────────────────────
backupRouter.post('/run', ...admin, async (_req, res) => {
  try {
    res.json(await runBackup('manual'));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'The backup could not run' });
  }
});

backupRouter.get('/download', ...admin, async (_req, res) => {
  const { data } = await buildBackup();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="glm-pos-backup-${stamp()}.json.gz${isEncryptedBackup(data) ? '.enc' : ''}"`);
  res.send(data);
});

backupRouter.get('/files/:name', ...admin, (req, res) => {
  const data = readLocal(String(req.params.name));
  if (!data) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.send(data);
});

// ── Restore ──────────────────────────────────────────────────────────────────
// Upload a backup file (or name one kept on the server with ?file=). `?check=1` only reads it and reports what it holds.
backupRouter.post('/restore', ...admin, rawBody, async (req, res) => {
  let raw: Buffer | null;
  if (typeof req.query.file === 'string') {
    raw = readLocal(req.query.file);
    if (!raw) return res.status(404).json({ error: 'Backup not found' });
  } else {
    raw = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!raw) return res.status(400).json({ error: 'Choose a backup file to restore' });
  }
  let file;
  try {
    file = await parseBackup(raw);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'That file could not be read' });
  }
  const counts = Object.fromEntries(Object.entries(file.tables).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
  if (req.query.check === '1') return res.json({ createdAt: file.createdAt, rows: totalRows(counts), counts });
  if (req.query.confirm !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm' });
  const before = await saveBeforeRestore();
  try {
    const restored = await restoreBackup(file);
    res.json({ ok: true, rows: totalRows(restored), counts: restored, savedBefore: before });
  } catch (err) {
    console.error('Restore failed', err);
    res.status(500).json({ error: `The restore failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ── Google Drive ─────────────────────────────────────────────────────────────
// 1. The Admin creates an OAuth client in Google Cloud Console and saves its ID and secret here (PUT /settings).
// 2. /google/connect gives the Google sign-in address; Google sends the browser back to /google/callback with a one-time code.
// 3. The code is swapped for a long-lived permission, and backups are copied into a "GLM POS Backups" folder in the Admin's Drive.
const connectSchema = z.object({ redirectUri: z.string().url(), returnUrl: z.string().url() });

backupRouter.post('/google/connect', ...admin, async (req, res) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const s = await getBackupSettings();
  if (!s.driveClientId || !s.driveClientSecret) return res.status(400).json({ error: 'Save the Google client ID and client secret first' });
  const state = crypto.randomBytes(24).toString('hex');
  await prisma.backupSettings.update({ where: { id: 1 }, data: { oauthState: state, oauthRedirectUri: parsed.data.redirectUri, oauthReturnUrl: parsed.data.returnUrl, oauthExpires: new Date(Date.now() + 10 * 60_000) } });
  res.json({ url: googleAuthUrl(s, parsed.data.redirectUri, state) });
});

// Google sends the browser here (no sign-in header), so it is trusted only through the one-time state saved by /google/connect.
backupRouter.get('/google/callback', async (req, res) => {
  const s = await getBackupSettings();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const valid = !!s.oauthState && state.length === s.oauthState.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(s.oauthState)) && !!s.oauthExpires && s.oauthExpires > new Date();
  if (!valid) return res.status(400).send('This Google sign-in link has expired or was not started from the system. Go back to Master Data → Backup & Restore and press Connect Google Drive again.');
  const back = (message: string) => {
    const url = new URL(s.oauthReturnUrl);
    url.searchParams.set('backup', message);
    res.redirect(url.toString());
  };
  await prisma.backupSettings.update({ where: { id: 1 }, data: { oauthState: '', oauthExpires: null } });
  if (typeof req.query.error === 'string') return back(`Google said: ${req.query.error}`);
  try {
    const refreshToken = await exchangeGoogleCode(s, String(req.query.code ?? ''));
    await prisma.backupSettings.update({ where: { id: 1 }, data: { driveRefreshToken: seal(refreshToken), driveConnectedAt: new Date(), driveFolderId: '', lastError: '' } });
    await prepareDrive();
    back('connected');
  } catch (err) {
    await prisma.backupSettings.update({ where: { id: 1 }, data: { driveRefreshToken: '', driveConnectedAt: null } });
    back(`Google Drive could not be connected: ${err instanceof Error ? err.message : String(err)}`);
  }
});

backupRouter.post('/google/disconnect', ...admin, async (_req, res) => {
  const s = await getBackupSettings();
  if (s.driveRefreshToken) await revokeGoogle(s.driveRefreshToken);
  await prisma.backupSettings.update({ where: { id: 1 }, data: { driveRefreshToken: '', driveFolderId: '', driveConnectedAt: null } });
  res.json({ ok: true });
});
