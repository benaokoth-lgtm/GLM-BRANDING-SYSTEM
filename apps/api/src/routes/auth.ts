import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { requireAuth, signToken } from '../middleware/auth';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const LOCK_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join('');
}

authRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(
    users.map((u) => ({ id: u.id, name: u.name, role: u.role, initials: initials(u.name) })),
  );
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { userId, pin } = req.body as { userId?: number; pin?: string };
  if (!userId || !pin) return res.status(400).json({ error: 'userId and pin are required' });

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) return res.status(401).json({ error: 'Invalid PIN' });

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return res.status(423).json({ error: 'Account locked, try again shortly' });
  }

  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) {
    const failedLoginCount = user.failedLoginCount + 1;
    const lockedUntil = failedLoginCount >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount, lockedUntil } });
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

  const authedUser = { id: user.id, name: user.name, role: user.role as 'Staff' | 'Supervisor' | 'Admin' };
  const token = signToken(authedUser);
  res.json({ token, user: authedUser });
});

authRouter.post('/change-pin', requireAuth, async (req, res) => {
  const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
  if (!newPin || !/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be 4 digits' });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPin || '', user.pinHash);
  if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect' });

  const pinHash = await bcrypt.hash(newPin, 10);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash } });
  res.json({ ok: true });
});
