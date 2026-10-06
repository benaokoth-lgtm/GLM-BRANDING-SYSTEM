import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { explainMailError, getMailer } from '../mailer';
import { requireAuth, signChallenge, signToken, verifyChallenge } from '../middleware/auth';
import { ipOf, writeAudit } from '../audit';
import { PIN_ROUNDS, clearPinFailures, minutesLeft, pinProblemFor, registerFailedPin, requiredLengthFor } from '../pins';
import type { User } from '@prisma/client';
import { permissionsForRole } from '../permissions';
import { commissionEnabled } from '../commission';
import { systemName } from '../company';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const changePinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `pin-${(req as { user?: { id: number } }).user?.id ?? 'anon'}`, validate: false });
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join('');
}

// The company name and logo, for the login page and the app header (nothing sensitive).
authRouter.get('/branding', async (_req, res) => {
  const s = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  res.set('Cache-Control', 'public, max-age=300'); // the logo can be large; it rarely changes
  // systemName is what the screens show (the system name if one is set, else the company name); companyName is for documents.
  res.json({ companyName: s.companyName, systemName: s.systemName.trim() || s.companyName, logoDataUrl: s.logoDataUrl });
});

// Which optional parts of the system are switched on (read fresh each time: an Admin can change them at any moment).
authRouter.get('/features', requireAuth, async (_req, res) => {
  res.json({ commission: await commissionEnabled() });
});

authRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  res.json(
    users.map((u) => ({ id: u.id, name: u.name, role: u.role, initials: initials(u.name), pinLength: u.pinLength })),
  );
});

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

// Finishes a sign-in: the session token and what the screen needs. Someone whose role needs a longer PIN than they have is made to change it.
async function completeLogin(req: import('express').Request, res: import('express').Response, user: User) {
  const need = await requiredLengthFor(user.role);
  let mustChangePin = user.mustChangePin;
  if (user.pinLength < need && !mustChangePin) {
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePin: true } });
    mustChangePin = true;
  }
  const authedUser = { id: user.id, name: user.name, role: user.role };
  const token = signToken({ ...authedUser, tv: user.tokenVersion });
  const permissions = await permissionsForRole(user.role);
  await writeAudit({ userId: user.id, userName: user.name, role: user.role, method: 'AUTH', action: 'LOGIN OK', ip: ipOf(req) });
  res.json({ token, user: { ...authedUser, permissions, mustChangePin, pinLength: user.pinLength, pinNeeds: need } });
}

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { userId, pin } = req.body as { userId?: number; pin?: string };
  if (!userId || !pin || typeof pin !== 'string') return res.status(400).json({ error: 'userId and pin are required' });

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) return res.status(401).json({ error: 'Invalid PIN' });
  const who = { userId: user.id, userName: user.name, role: user.role, method: 'AUTH', ip: ipOf(req) };
  if (!user.active) {
    await writeAudit({ ...who, action: 'LOGIN REFUSED — sign-in is switched off' });
    return res.status(401).json({ error: 'This sign-in has been switched off. Ask the Admin if you think this is a mistake.' });
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = minutesLeft(user.lockedUntil);
    await writeAudit({ ...who, action: 'LOGIN REFUSED — account is locked' });
    return res.status(423).json({ error: `This account is locked after too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryAfterMinutes: minutes });
  }

  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) {
    const r = await registerFailedPin(user, ipOf(req));
    await writeAudit({ ...who, action: 'LOGIN FAILED — wrong PIN' });
    return res.status(401).json({ error: 'Invalid PIN', ...(r.lockedMinutes ? { lockedMinutes: r.lockedMinutes } : {}) });
  }
  await clearPinFailures(user.id);

  // The Admin can ask for an emailed code after the PIN. If the code cannot be sent (no email address, mail down) the Admin is not locked out:
  // sign-in goes ahead on the PIN alone, and that is recorded.
  const setting = await prisma.setting.findUnique({ where: { id: 1 } });
  if (setting?.requireAdminCode && user.role === 'Admin' && user.email) {
    const mailer = await getMailer();
    if (mailer) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await prisma.user.update({ where: { id: user.id }, data: { loginCodeHash: await bcrypt.hash(code, PIN_ROUNDS), loginCodeExpires: new Date(Date.now() + CODE_MINUTES * 60_000), loginCodeAttempts: 0 } });
      try {
        await mailer.sendMail({
          to: user.email,
          subject: `${await systemName()} — sign-in code`,
          text: `Your sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.\n\nIf you did not just enter your PIN, someone else knows it — change it and tell your manager.`,
        });
        await writeAudit({ ...who, action: 'LOGIN CODE SENT' });
        return res.json({ codeRequired: true, challenge: signChallenge(user.id), sentTo: maskEmail(user.email) });
      } catch (e) {
        await prisma.user.update({ where: { id: user.id }, data: { loginCodeHash: null, loginCodeExpires: null } });
        await writeAudit({ ...who, action: 'LOGIN CODE NOT SENT — the email failed, signed in on the PIN alone', detail: explainMailError(e, mailer.config) });
      }
    }
  }
  return completeLogin(req, res, user);
});

// The second step: the code emailed to the Admin, with the proof from the first step that the PIN was right.
authRouter.post('/login-code', loginLimiter, async (req, res) => {
  const { challenge, code } = req.body as { challenge?: string; code?: string };
  const expired = { error: 'This sign-in has expired. Start again.' };
  const id = verifyChallenge(challenge);
  if (id === null || typeof code !== 'string') return res.status(401).json(expired);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !user.active || !user.loginCodeHash || !user.loginCodeExpires || user.loginCodeExpires < new Date()) return res.status(401).json(expired);
  const who = { userId: user.id, userName: user.name, role: user.role, method: 'AUTH', ip: ipOf(req) };
  if (!(await bcrypt.compare(code.trim(), user.loginCodeHash))) {
    const attempts = user.loginCodeAttempts + 1;
    await prisma.user.update({ where: { id: user.id }, data: attempts >= CODE_MAX_ATTEMPTS ? { loginCodeHash: null, loginCodeExpires: null, loginCodeAttempts: 0 } : { loginCodeAttempts: attempts } });
    await writeAudit({ ...who, action: 'LOGIN CODE WRONG' });
    return res.status(401).json({ error: attempts >= CODE_MAX_ATTEMPTS ? 'Too many wrong codes. Start again.' : 'That code is not right' });
  }
  await prisma.user.update({ where: { id: user.id }, data: { loginCodeHash: null, loginCodeExpires: null, loginCodeAttempts: 0 } });
  return completeLogin(req, res, user);
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

  const mailer = await getMailer();
  if (!mailer) {
    return res.status(501).json({ error: "Email isn't set up yet. An Admin can set it up under Master Data → Email, or use reset-pin.js on the server." });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || user.role !== 'Admin') return res.json(GENERIC_FORGOT_REPLY);

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
    await mailer.sendMail({
      to: email,
      subject: `${await systemName()} — PIN reset code`,
      text: `Your PIN reset code is ${code}. It expires in ${RESET_CODE_MINUTES} minutes.\n\nIf you didn't ask for this, ignore this email — your PIN has not changed.`,
    });
  } catch (e) {
    return res.status(502).json({ error: `The reset email could not be sent. ${explainMailError(e, mailer.config)}` });
  }
  res.json(GENERIC_FORGOT_REPLY);
});

authRouter.post('/reset-pin', resetLimiter, async (req, res) => {
  const { code, newPin } = req.body as { code?: string; newPin?: string };
  const email = normalizeEmail((req.body as { email?: string }).email);
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  if (!newPin || typeof newPin !== 'string') return res.status(400).json({ error: 'A new PIN is required' });
  const weak = await pinProblemFor(newPin, 'Admin'); // this reset is for the Admin only
  if (weak) return res.status(400).json({ error: weak });

  const invalid = { error: 'That code is invalid or has expired. Request a new one.' };
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || user.role !== 'Admin' || !user.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires < new Date()) {
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
      pinHash: await bcrypt.hash(newPin, PIN_ROUNDS),
      pinLength: newPin.length,
      tokenVersion: { increment: 1 }, // any session opened with the old PIN ends
      failedLoginCount: 0,
      lockCount: 0,
      lockedUntil: null,
      resetCodeHash: null,
      resetCodeExpires: null,
      resetAttempts: 0,
      mustChangePin: false,
    },
  });
  res.json({ ok: true });
});

authRouter.post('/change-pin', requireAuth, changePinLimiter, async (req, res) => {
  const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
  if (typeof newPin !== 'string') return res.status(400).json({ error: 'A new PIN is required' });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = minutesLeft(user.lockedUntil);
    return res.status(423).json({ error: `This account is locked after too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  const problem = await pinProblemFor(newPin, user.role);
  if (problem) return res.status(400).json({ error: problem });

  // Guessing the current PIN here counts like a wrong PIN at sign-in. 400, not 401: the web client treats any 401 as an expired session and logs out.
  if (!(await bcrypt.compare(typeof currentPin === 'string' ? currentPin : '', user.pinHash))) {
    await registerFailedPin(user, ipOf(req));
    return res.status(400).json({ error: 'Current PIN is incorrect' });
  }
  if (newPin === currentPin) return res.status(400).json({ error: 'The new PIN must differ from the current one' });

  // Every other session this person has open ends; this one carries on with a fresh token.
  const saved = await prisma.user.update({
    where: { id: user.id },
    data: { pinHash: await bcrypt.hash(newPin, PIN_ROUNDS), pinLength: newPin.length, mustChangePin: false, failedLoginCount: 0, lockCount: 0, lockedUntil: null, tokenVersion: { increment: 1 } },
  });
  await writeAudit({ userId: user.id, userName: user.name, role: user.role, method: 'AUTH', action: 'PIN CHANGED', ip: ipOf(req) });
  res.json({ ok: true, token: signToken({ id: saved.id, name: saved.name, role: saved.role, tv: saved.tokenVersion }) });
});
