// Where a sale comes from: GLM (the shop's own sale, credited to no sales person) or a sales person (credited to someone who brings us work). There is one price list for both. The front office
// allocates each order when it is captured, and a sales person who captures their own is allocated to themselves; the order carries that as a label (Order.priceList — 'glm' or 'freelancer', the
// column keeps its older name), and the lists and the performance report tell the two apart by who the order is credited to, so older orders count too.
import { prisma } from './db';

export type OrderLabel = 'glm' | 'freelancer';

/** The roles of sales persons: the ones marked "can be assigned orders". */
export async function salesPersonRoleNames(): Promise<string[]> {
  return (await prisma.role.findMany({ where: { canBeAssignedOrders: true }, select: { name: true } })).map((r) => r.name);
}

/** The ids of everyone in a sales-person role (active or not: history must keep counting for someone who has left). */
export async function salesPersonIds(): Promise<Set<number>> {
  const roles = await salesPersonRoleNames();
  if (roles.length === 0) return new Set();
  return new Set((await prisma.user.findMany({ where: { role: { in: roles } }, select: { id: true } })).map((u) => u.id));
}

/** The label an order captured now carries: 'freelancer' when it is credited to a sales person, else 'glm'. */
export async function labelFor(staffId: number): Promise<OrderLabel> {
  const u = await prisma.user.findUnique({ where: { id: staffId }, select: { role: true } });
  if (!u) return 'glm';
  const roles = await salesPersonRoleNames();
  return roles.includes(u.role) ? 'freelancer' : 'glm';
}

/**
 * Is this order a sales person's? It is when it is credited to a sales person — the person it was allocated to (staffId), or the one whose client it is (sourcedByStaffId) — or to an old freelance
 * account. Anything else is GLM's own.
 */
export function isSalesPersonOrder(o: { staffId: number; sourcedByStaffId: number | null; freelanceAgentId: number | null }, people: Set<number>): boolean {
  return o.freelanceAgentId != null || people.has(o.sourcedByStaffId ?? o.staffId);
}
