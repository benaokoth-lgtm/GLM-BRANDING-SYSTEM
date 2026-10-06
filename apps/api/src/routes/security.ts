// Master Data → Security (Admin only): a checklist of the protections that are on, the Admin sign-in code switch, and the audit log.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole, jwtSecretStrong } from '../middleware/auth';
import { dataKeyConfigured } from '../crypto';
import { secretStatus } from '../secrets';
import { getMailer } from '../mailer';
import { requiredLengthFor } from '../pins';

export const securityRouter = Router();
securityRouter.use(requireAuth, requireRole('Admin'));

securityRouter.get('/status', async (req, res) => {
  const setting = await prisma.setting.findUnique({ where: { id: 1 } });
  const users = await prisma.user.findMany({ select: { id: true, name: true, role: true, active: true, email: true, pinLength: true } });
  const active = users.filter((u) => u.active);
  const short: string[] = [];
  for (const u of active) if (u.pinLength < (await requiredLengthFor(u.role))) short.push(u.name);
  const admins = active.filter((u) => u.role === 'Admin');
  res.json({
    dataKey: dataKeyConfigured(),
    unsealedSecrets: (await secretStatus()).unsealed,
    jwtSecretStrong: jwtSecretStrong(),
    requireAdminCode: !!setting?.requireAdminCode,
    mailConfigured: !!(await getMailer()),
    youHaveEmail: !!users.find((u) => u.id === req.user!.id)?.email,
    adminsWithoutEmail: admins.filter((a) => !a.email).map((a) => a.name),
    shortPinPeople: short, // people whose role needs a longer PIN than they have (they change it at next sign-in)
    activeUsers: active.length,
    switchedOff: users.length - active.length,
  });
});

// Asking Admins for an emailed code only makes sense once the mail account works and you can receive it yourself.
securityRouter.put('/settings', async (req, res) => {
  const parsed = z.object({ requireAdminCode: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  if (parsed.data.requireAdminCode) {
    const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!me?.email) return res.status(400).json({ error: 'Add your own email address under Staff & Users first — the code is sent to it, and you would not be able to sign in without it' });
    if (!(await getMailer())) return res.status(400).json({ error: 'Set up the mail account under Master Data → Email first' });
  }
  await prisma.setting.upsert({ where: { id: 1 }, update: { requireAdminCode: parsed.data.requireAdminCode }, create: { id: 1, requireAdminCode: parsed.data.requireAdminCode } });
  res.json({ ok: true, requireAdminCode: parsed.data.requireAdminCode });
});

// The audit trail, newest first. Filters: from / to (YYYY-MM-DD), user (part of a name), q (part of the action, path or detail).
securityRouter.get('/audit', async (req, res) => {
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(req.query.from);
  const to = day(req.query.to);
  const user = typeof req.query.user === 'string' ? req.query.user.trim().toLowerCase() : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
  const rows = await prisma.auditLog.findMany({
    where: { at: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } },
    orderBy: { id: 'desc' },
    take: 5000,
  });
  const hit = (r: (typeof rows)[number]) =>
    (!user || r.userName.toLowerCase().includes(user)) && (!q || `${r.action} ${r.path} ${r.detail}`.toLowerCase().includes(q));
  const matched = rows.filter(hit);
  res.json({ total: matched.length, rows: matched.slice(0, limit) });
});
