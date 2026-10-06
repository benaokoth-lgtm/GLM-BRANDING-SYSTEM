import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { PermissionKey, Role } from '@glm/shared';
import { prisma } from '../db';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export interface AuthedUser {
  id: number;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

// `tv` is the person's token version at sign-in: raising it on the user ends every session issued before (see requireAuth).
export function signToken(user: AuthedUser & { tv?: number }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });
}

// A valid token is not enough: the person must still exist, still be switched on, and not have had their sessions ended. The name and role
// used for the rest of the request come from the database, not the token, so a change of role or a switch-off applies straight away.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  let payload: AuthedUser & { tv?: number };
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET) as AuthedUser & { tv?: number };
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  if (typeof payload.id !== 'number') return res.status(401).json({ error: 'Invalid or expired session' });
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, name: true, role: true, active: true, tokenVersion: true } });
    if (!user || !user.active || (payload.tv ?? 0) !== user.tokenVersion) return res.status(401).json({ error: 'Your session has ended — sign in again' });
    req.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Does this role hold the permission? (Admin always does.) */
export async function userHasPermission(roleName: string, key: PermissionKey): Promise<boolean> {
  if (roleName === 'Admin') return true;
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  return !!role && !!role[key];
}

// Still used for the handful of truly fixed, Admin-only actions (Master Data
// catalog mutation, role management itself) — not for anything a Master
// Data-configured role should be able to unlock, which uses
// requirePermission below instead.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not permitted for your role' });
    }
    next();
  };
}

// Looked up live against the Role table on every gated request (not cached
// in the JWT), so a permission change made in Master Data → Roles & Access
// takes effect for a user immediately, without needing to log out and back
// in. 'Admin' always passes regardless of its stored flags — the one fixed
// recovery path if a permissions mistake elsewhere locks a role out of
// something it needs. Accepts multiple keys with OR semantics (any one
// grants access), matching requireRole's existing multi-role behavior.
export function requirePermission(...keys: PermissionKey[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'Admin') return next();
    const role = await prisma.role.findUnique({ where: { name: req.user.role } });
    if (!role || !keys.some((k) => role[k])) {
      return res.status(403).json({ error: 'Not permitted for your role' });
    }
    next();
  };
}
