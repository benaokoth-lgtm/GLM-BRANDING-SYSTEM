// Front office: a receptionist / cashier who captures General, Film and Artwork orders on behalf of the sales persons (and for freelancers), and takes the
// money. Every order then has two people on it: the SALES PERSON it is credited to (Order.staffId — their order list, their film/artwork extras, their
// sales target, the client credited to them) and the person who KEYED it (Order.capturedById — the cashier). A sales person capturing their own order is
// both. Order taking can also be switched off for a sales person (User.orderTakingOff): they keep every other duty — production, quality control and so
// on, as set in Master Data → Roles & Access — and the front office captures for them.
import { DEFAULT_ROLE_PERMISSIONS } from '@glm/shared';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

/** May this role capture orders in someone else's name (the front office)? Admin always may. */
export async function canCaptureForOthers(role: string): Promise<boolean> {
  return role === 'Admin' || (await permissionsForRole(role)).canCaptureForOthers;
}

export type CaptureResult = { ok: true; staffId: number; capturedById: number; capturedByName: string } | { ok: false; status: number; error: string };

/**
 * Who an order is credited to and who keyed it, decided here (never trusted from the browser).
 *  • Someone who may capture for others (front office, Admin) can name any ACTIVE sales person — a person whose role is marked "can be assigned
 *    orders" — or leave it blank, which is a house sale in their own name.
 *  • Everyone else captures in their own name only, and not at all while their order taking is switched off.
 */
export async function resolveCapture(user: { id: number; name: string; role: string }, requested?: number | null, sourcedBy?: number | null): Promise<CaptureResult> {
  const mine = { capturedById: user.id, capturedByName: user.name };
  if (!(await canCaptureForOthers(user.role))) {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { orderTakingOff: true } });
    if (me?.orderTakingOff) return { ok: false, status: 403, error: 'Order taking is switched off for you. The front office captures orders for you.' };
    if (requested && requested !== user.id) return { ok: false, status: 403, error: 'You can only capture orders in your own name' };
    return { ok: true, staffId: user.id, ...mine };
  }
  let staffId = user.id;
  if (requested && requested !== user.id) {
    const target = await prisma.user.findUnique({ where: { id: requested } });
    if (!target || !target.active) return { ok: false, status: 400, error: 'That sales person cannot be found' };
    if (!(await permissionsForRole(target.role)).canBeAssignedOrders) {
      return { ok: false, status: 400, error: `${target.name} is not set up to be given orders (tick “can be assigned orders” for their role under Master Data → Roles & Access)` };
    }
    staffId = requested;
  }
  // A client is credited to the sales person the order is for, nobody else (managers who handle commission may still credit anyone, as before).
  if (sourcedBy && sourcedBy !== staffId && user.role !== 'Admin' && !(await permissionsForRole(user.role)).canManageCommission) {
    return { ok: false, status: 400, error: 'The client can only be credited to the sales person the order is for' };
  }
  return { ok: true, staffId, ...mine };
}

/** The sales persons orders can be given to: active people whose role is marked "can be assigned orders", and whether their own order taking is off. */
export async function salesPeople(): Promise<{ id: number; name: string; role: string; orderTakingOff: boolean }[]> {
  const roles = await prisma.role.findMany({ where: { canBeAssignedOrders: true }, select: { name: true } });
  if (roles.length === 0) return [];
  const users = await prisma.user.findMany({ where: { active: true, role: { in: roles.map((r) => r.name) } }, orderBy: { name: 'asc' } });
  return users.map((u) => ({ id: u.id, name: u.name, role: u.role, orderTakingOff: u.orderTakingOff }));
}

/** What the screens may offer this person: while their order taking is off they cannot see the order-taking screens (the server refuses them anyway). */
export async function permissionsForUser(user: { role: string; orderTakingOff: boolean }) {
  const p = await permissionsForRole(user.role);
  if (user.orderTakingOff && user.role !== 'Admin' && !p.canCaptureForOthers) return { ...p, canCaptureOrders: false, canAccessDtf: false };
  return p;
}

/** Once, on databases that pre-date this: creates the Front Office role and marks the Staff role as one that can be given orders. */
export async function ensureFrontOfficeAccess(): Promise<void> {
  const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (settings.frontOfficeSeeded) return;
  // Every role that captures orders today (Staff, Sales …) is one the front office can give orders to; the Admin can untick any under Roles & Access.
  if ((await prisma.role.count({ where: { canBeAssignedOrders: true } })) === 0) {
    await prisma.role.updateMany({ where: { canCaptureOrders: true, canCaptureForOthers: false }, data: { canBeAssignedOrders: true } });
  }
  if ((await prisma.role.count({ where: { canCaptureForOthers: true } })) === 0 && !(await prisma.role.findUnique({ where: { name: 'Front Office' } }))) {
    await prisma.role.create({ data: { name: 'Front Office', ...DEFAULT_ROLE_PERMISSIONS['Front Office']! } });
  }
  await prisma.setting.update({ where: { id: 1 }, data: { frontOfficeSeeded: true } });
}
let seeding: Promise<void> | null = null;
export function ensureFrontOfficeOnce(): Promise<void> {
  if (!seeding) seeding = ensureFrontOfficeAccess().catch((e) => console.error('Front office set-up failed', e)).finally(() => (seeding = null));
  return seeding;
}
