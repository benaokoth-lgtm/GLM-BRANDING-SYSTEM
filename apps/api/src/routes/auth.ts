import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { buildTransport, mailFrom } from '../mailer';
import { requireAuth, signToken } from '../middleware/auth';
import { permissionsForRole } from '../permissions';

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

  const authedUser = { id: user.id, name: user.name, role: user.role };
  const token = signToken(authedUser);
  const permissions = await permissionsForRole(user.role);
  res.json({ token, user: { ...authedUser, permissions } });
});

// ── Emailed PIN reset (Admin only) ──────────────────────────────────────────
// Only a user with role 'Admin' AND a stored email can use this — staff PINs are
// reset by the Admin under Master Data. The 6-digit code is stored as a bcrypt
// hash, expires in 15 minutes, allows 5 guesses, and is single-use.
const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const GENERIC_FORGOT_REPLY = { ok: true, message: 'If that email belongs to an Admin, a reset code has been sent.' };

function normalizeEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

authRouter.post('/forgot-pin', resetLimiter, async (req, res) => {
  const email = normalizeEmail((req.body as { email?: string }).email);
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const transport = buildTransport();
  if (!transport) {
    return res.status(501).json({ error: 'Email isn\'t configured on the server yet (SMTP settings). Ask whoever manages the hosting, or use reset-pin.js on the server.' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.role !== 'Admin') return res.json(GENERIC_FORGOT_REPLY);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetCodeHash: await bcrypt.hash(code, 10),
      resetCodeExpires: new Date(Date.now() + RESET_CODE_MINUTES * 60 * 1000),
      resetAttempts: 0,
    },
  });

  try {
    await transport.sendMail({
      from: mailFrom(),
      to: email,
      subject: 'GLM Branding POS — PIN reset code',
      text: `Your PIN reset code is ${code}. It expires in ${RESET_CODE_MINUTES} minutes.\n\nIf you didn't ask for this, ignore this email — your PIN has not changed.`,
    });
  } catch {
    return res.status(502).json({ error: 'The reset email could not be sent. Check the server\'s SMTP settings.' });
  }
  res.json(GENERIC_FORGOT_REPLY);
});

authRouter.post('/reset-pin', resetLimiter, async (req, res) => {
  const { code, newPin } = req.body as { code?: string; newPin?: string };
  const email = normalizeEmail((req.body as { email?: string }).email);
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  if (!newPin || !/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be 4 digits' });

  const invalid = { error: 'That code is invalid or has expired. Request a new one.' };
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.role !== 'Admin' || !user.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires < new Date()) {
    return res.status(400).json(invalid);
  }
  if (user.resetAttempts >= RESET_MAX_ATTEMPTS) {
    await prisma.user.update({ where: { id: user.id }, data: { resetCodeHash: null, resetCodeExpires: null } });
    return res.status(400).json(invalid);
  }

  const ok = await bcrypt.compare(String(code).trim(), user.resetCodeHash);
  if (!ok) {
    await prisma.user.update({ where: { id: user.id }, data: { resetAttempts: user.resetAttempts + 1 } });
    return res.status(400).json(invalid);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      pinHash: await bcrypt.hash(newPin, 10),
      failedLoginCount: 0,
      lockedUntil: null,
      resetCodeHash: null,
      resetCodeExpires: null,
      resetAttempts: 0,
    },
  });
  res.json({ ok: true });
});

authRouter.post('/change-pin', requireAuth, async (req, res) => {
  const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
  if (!newPin || !/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be 4 digits' });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPin || '', user.pinHash);
  // 400, not 401: the web client treats any 401 as an expired session and logs out.
  if (!ok) return res.status(400).json({ error: 'Current PIN is incorrect' });

  const pinHash = await bcrypt.hash(newPin, 10);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash } });
  res.json({ ok: true });
});
