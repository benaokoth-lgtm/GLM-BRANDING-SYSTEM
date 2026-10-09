// The audit trail: who did what, when, from where. A middleware records every change made through the API (and a short list of sensitive
// reads), and sign-in events are recorded by name from the auth routes. Recording never gets in the way of the request: a failure to write
// a row is logged and ignored.
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './db';

/** Field names whose values are never written to the log, whatever route they arrive on. */
const SECRET_KEY = /pin|pass|secret|token|html|logo|raw|authorization|credential|^code$|^key$|apikey|consumerkey|privatekey/i;
const MAX_DETAIL = 1500;

export function ipOf(req: Request): string {
  return (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/** A short, safe summary of a request body: field names, with small plain values shown and secrets left out. */
export function summarise(body: unknown): string {
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) parts.push(`${k}=•••`);
    else if (v === null || v === undefined) parts.push(`${k}=∅`);
    else if (typeof v === 'string') parts.push(`${k}=${v.length > 60 ? v.slice(0, 57) + '…' : v}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else parts.push(`${k}={…}`);
  }
  return parts.join(', ').slice(0, MAX_DETAIL);
}

export interface AuditEntry {
  userId?: number | null;
  userName?: string;
  role?: string;
  method?: string;
  action: string;
  path?: string;
  status?: number;
  detail?: string;
  ip?: string;
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: e.userId ?? null,
        userName: e.userName ?? '',
        role: e.role ?? '',
        method: e.method ?? '',
        action: e.action.slice(0, 200),
        path: (e.path ?? '').slice(0, 300),
        status: e.status ?? 0,
        detail: (e.detail ?? '').slice(0, MAX_DETAIL),
        ip: e.ip ?? '',
      },
    });
  } catch (err) {
    console.error('Audit log write failed', err);
  }
}

// Reads worth recording: who downloaded a backup, opened the staff identity details, payroll or a P9.
const AUDITED_READS = [/^\/api\/backup\//, /^\/api\/finance\/(employees|p9|payroll)/, /^\/api\/master-data\/staff-details/, /^\/api\/pricelists\/.*\.xlsx$/];
// Left to the code that handles them (they are not made by a signed-in person, or are recorded by name with more meaning).
const SKIPPED = [/^\/api\/auth\/login/, /^\/api\/auth\/forgot-pin/, /^\/api\/auth\/reset-pin/, /^\/api\/mpesa\/(callback|c2b)/, /^\/api\/ncba\/notify\//, /^\/api\/health/];

/** Records every successful change, and every refused one (401/403), plus the sensitive reads above. */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    const url = req.originalUrl.split('?')[0]!;
    if (SKIPPED.some((r) => r.test(url))) return;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const refused = res.statusCode === 403; // (401 is an expired or missing session — no identity to record)
    const sensitiveRead = !write && res.statusCode < 400 && AUDITED_READS.some((r) => r.test(url));
    if (!(write && (res.statusCode < 400 || refused)) && !sensitiveRead && !(refused && !write)) return;
    const route = req.route?.path ? `${req.baseUrl}${typeof req.route.path === 'string' ? req.route.path : ''}` : url;
    void writeAudit({
      userId: req.user?.id ?? null,
      userName: req.user?.name ?? '',
      role: req.user?.role ?? '',
      method: req.method,
      action: `${req.method} ${route}${refused ? ' — REFUSED' : ''}`,
      path: url,
      status: res.statusCode,
      detail: write ? summarise(req.body) : '',
      ip: ipOf(req),
    });
  });
  next();
}

/** Keep two years; called once at start-up. */
export async function pruneAudit(): Promise<void> {
  try {
    await prisma.auditLog.deleteMany({ where: { at: { lt: new Date(Date.now() - 730 * 24 * 3600 * 1000) } } });
  } catch (err) {
    console.error('Audit prune failed', err);
  }
}
