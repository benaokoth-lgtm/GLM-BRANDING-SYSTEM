import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { approvalsFor, approvalsSummary } from '../approvals';

// The approvals inbox. Everyone signed in has one: those who can decide see what waits for them, and everyone sees how their own requests went. Deciding is done on each kind of request's own
// endpoint (the paths are in every item), so each keeps its own rules — nobody decides their own request, and only the right roles decide.
export const approvalsRouter = Router();
approvalsRouter.use(requireAuth);

approvalsRouter.get('/', async (req, res) => {
  const [lists, setting] = await Promise.all([approvalsFor(req.user!), prisma.setting.findUnique({ where: { id: 1 } })]);
  res.json({ ...lists, emailOn: setting?.approvalEmails ?? true });
});

// Light enough to ask every minute: the number for the menu badge.
approvalsRouter.get('/summary', async (req, res) => {
  res.json(await approvalsSummary(req.user!));
});

// Emailing those who can decide, when a request is raised (Admin).
approvalsRouter.put('/email', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ on: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Say whether emails are on' });
  await prisma.setting.upsert({ where: { id: 1 }, update: { approvalEmails: parsed.data.on }, create: { id: 1, approvalEmails: parsed.data.on } });
  res.json({ emailOn: parsed.data.on });
});
