import { DISCOUNT_ROLES, VAT_RATE, canGiveDiscount, costingJobLabel, tidyCostingSummary } from '@glm/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { permissionsForRole } from './permissions';
import { getMailer } from './mailer';

// The approvals inbox: everything that is waiting for somebody's decision, in one list. Each kind of request keeps its own rules and its own decision endpoint (a quote's price, a discount,
// an expense correction …); the inbox only gathers what a person may decide, with the paths to approve or turn it down, and — for the requester — how their own requests went.
// "Notifications" are the badge in the menu (the number waiting, plus the decisions on your own requests you have not looked at yet) and an email to those who can decide, when a new
// request is raised and mail is set up.

export type ApprovalSource = 'costing' | 'artwork' | 'discount' | 'amend' | 'deletion' | 'requisition' | 'leave';

export const SOURCE_LABEL: Record<ApprovalSource, string> = {
  costing: 'Job Costing price',
  artwork: 'Price below recommended',
  discount: 'Unit price discount',
  amend: 'Expense correction',
  deletion: 'Deletion',
  requisition: 'Stock requisition',
  leave: 'Leave',
};

export interface ApprovalItem {
  key: string;
  source: ApprovalSource;
  sourceLabel: string;
  title: string;
  detail: string;
  /** What is at stake, in Ksh, when there is one (a shortfall, a total). */
  amount: number | null;
  requestedByName: string;
  requestedAt: string;
  status: string;
  decidedByName: string | null;
  decidedAt: string | null;
  note: string | null;
  /** Where to open it in the system. */
  link: string;
  /** How to decide it from the inbox; null when it has to be opened (leave can need a confirmation). */
  decide: { approve: string; reject: string; needsReason: boolean } | null;
}

export interface Who {
  id: number;
  name: string;
  role: string;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const ksh = (n: number) => 'Ksh ' + r2(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const RECENT_DAYS = 14;
const recentSince = () => new Date(Date.now() - RECENT_DAYS * 86_400_000);
const decided = (s: string) => s !== 'Pending';

type Part = { waiting: ApprovalItem[]; mine: ApprovalItem[] };

async function costing(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  // the decision endpoint wants cost access and a role that works on quotes (captures orders, or Finance)
  const sees = u.role === 'Admin' || (perms.canSeeCosts && (perms.canCaptureOrders || perms.canAccessFinance));
  const since = recentSince();
  const rows = await prisma.costingQuote.findMany({
    where: { OR: [...(sees ? [{ approval: 'Pending', staffId: { not: u.id } }] : []), { staffId: u.id, approval: { not: '' }, OR: [{ approval: 'Pending' }, { approvedAt: { gte: since } }] }] },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const make = (q: (typeof rows)[number]): ApprovalItem => {
    const agreed = q.agreedPrice != null ? r2(q.agreedPrice * (1 + VAT_RATE)) : null;
    const lowest = r2(q.cost * (1 + q.floorMarginPct / 100) * (1 + VAT_RATE));
    return {
      key: `costing:${q.id}`,
      source: 'costing',
      sourceLabel: SOURCE_LABEL.costing,
      title: `${q.quoteNo} — ${q.clientName || 'Walk-in'}`,
      detail: `${costingJobLabel(q.jobType)}: ${tidyCostingSummary(q.summary)}. Price agreed ${agreed != null ? ksh(agreed) : '—'} with VAT; the lowest without approval is ${ksh(lowest)}.`,
      amount: agreed,
      requestedByName: q.staffName,
      requestedAt: q.createdAt.toISOString(),
      status: q.approval,
      decidedByName: q.approvedByName || null,
      decidedAt: q.approvedAt?.toISOString() ?? null,
      note: q.approvalNote || null,
      link: '/costing',
      decide: { approve: `/costing/quotes/${q.id}/approve`, reject: `/costing/quotes/${q.id}/reject`, needsReason: true },
    };
  };
  return {
    waiting: rows.filter((q) => q.approval === 'Pending' && q.staffId !== u.id).map(make),
    mine: rows.filter((q) => q.staffId === u.id).map(make),
  };
}

async function artwork(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  const since = recentSince();
  const rows = await prisma.priceApproval.findMany({
    where: { OR: [...(perms.canManageDtf ? [{ status: 'Pending', requestedById: { not: u.id } }] : []), { requestedById: u.id, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const make = (a: (typeof rows)[number]): ApprovalItem => ({
    key: `artwork:${a.id}`,
    source: 'artwork',
    sourceLabel: SOURCE_LABEL.artwork,
    title: `${a.orderNo} — ${a.client || 'Walk-in'}`,
    detail: `${a.kind === 'embroidery' ? 'Embroidery job' : 'Artwork job'}: ${a.pieces} pieces at ${ksh(a.chargedPerPiece)} instead of ${ksh(a.systemPerPiece)} each — ${ksh(a.shortfall)} given away.`,
    amount: a.shortfall,
    requestedByName: a.requestedByName,
    requestedAt: a.requestedAt.toISOString(),
    status: a.status,
    decidedByName: a.decidedByName,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    note: a.reason,
    link: a.kind === 'embroidery' ? '/orders/new/embroidery' : '/dtf',
    decide: { approve: `/dtf/approvals/${a.id}/approve`, reject: `/dtf/approvals/${a.id}/reject`, needsReason: true },
  });
  return { waiting: rows.filter((a) => a.status === 'Pending' && a.requestedById !== u.id).map(make), mine: rows.filter((a) => a.requestedById === u.id).map(make) };
}

async function discount(u: Who): Promise<Part> {
  const since = recentSince();
  const may = canGiveDiscount(u.role);
  const rows = await prisma.discountRequest.findMany({
    where: { OR: [...(may ? [{ status: 'Pending', requestedById: { not: u.id } }] : []), { requestedById: u.id, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const make = (r: (typeof rows)[number]): ApprovalItem => {
    const spec = JSON.parse(r.spec) as Record<string, number>;
    const job = r.product === 'pens' ? `${spec.pens} UV pens` : `${spec.pieces} × ${spec.widthCm} × ${spec.heightCm} cm on the UV flatbed`;
    return {
      key: `discount:${r.id}`,
      source: 'discount',
      sourceLabel: SOURCE_LABEL.discount,
      title: `${job}`,
      detail: `${r.kind === 'pct' ? `${r.value}% off` : `${ksh(r.value)} off each`}: ${ksh(r.unitBefore)} → ${ksh(r.unitAfter)} a piece.`,
      amount: null,
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt.toISOString(),
      status: r.status,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      note: r.reason,
      link: '/orders/new/uv-film',
      decide: { approve: `/dtf/discount-requests/${r.id}/approve`, reject: `/dtf/discount-requests/${r.id}/reject`, needsReason: true },
    };
  };
  return { waiting: rows.filter((r) => r.status === 'Pending' && r.requestedById !== u.id).map(make), mine: rows.filter((r) => r.requestedById === u.id).map(make) };
}

async function amend(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  const since = recentSince();
  const rows = await prisma.expenseAmendment.findMany({
    where: { OR: [...(perms.canAccessFinance ? [{ status: 'Pending', requestedByName: { not: u.name } }] : []), { requestedByName: u.name, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    include: { expense: true },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const make = (a: (typeof rows)[number]): ApprovalItem => ({
    key: `amend:${a.id}`,
    source: 'amend',
    sourceLabel: SOURCE_LABEL.amend,
    title: `${a.expense.category} on ${a.expense.date}`,
    detail: `${ksh(a.expense.amount)} → ${ksh(a.proposedAmount)}${a.proposedCategory !== a.expense.category ? `, category ${a.expense.category} → ${a.proposedCategory}` : ''}${a.proposedDate !== a.expense.date ? `, date → ${a.proposedDate}` : ''}. Reason: ${a.reason}`,
    amount: r2(a.proposedAmount - a.expense.amount),
    requestedByName: a.requestedByName,
    requestedAt: a.requestedAt.toISOString(),
    status: a.status,
    decidedByName: a.decidedByName,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    note: null,
    link: '/finance',
    decide: { approve: `/finance/expenses/amendments/${a.id}/approve`, reject: `/finance/expenses/amendments/${a.id}/reject`, needsReason: false },
  });
  return { waiting: rows.filter((a) => a.status === 'Pending' && a.requestedByName !== u.name).map(make), mine: rows.filter((a) => a.requestedByName === u.name).map(make) };
}

async function deletion(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  const since = recentSince();
  const rows = await prisma.deletionRequest.findMany({
    where: { OR: [...(perms.canAccessFinance ? [{ status: 'Pending', requestedByName: { not: u.name } }] : []), { requestedByName: u.name, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const kind: Record<string, string> = { Expense: 'an expense', PayrollEntry: 'a payroll entry', PettyCashTopUp: 'a petty cash top-up' };
  const make = (d: (typeof rows)[number]): ApprovalItem => ({
    key: `deletion:${d.id}`,
    source: 'deletion',
    sourceLabel: SOURCE_LABEL.deletion,
    title: `Delete ${kind[d.recordType] ?? d.recordType}`,
    detail: `${d.summary}. Reason: ${d.reason}`,
    amount: null,
    requestedByName: d.requestedByName,
    requestedAt: d.requestedAt.toISOString(),
    status: d.status,
    decidedByName: d.decidedByName,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    note: null,
    link: d.recordType === 'PayrollEntry' ? '/compliance' : '/finance',
    decide: { approve: `/finance/deletion-requests/${d.id}/approve`, reject: `/finance/deletion-requests/${d.id}/reject`, needsReason: false },
  });
  return { waiting: rows.filter((d) => d.status === 'Pending' && d.requestedByName !== u.name).map(make), mine: rows.filter((d) => d.requestedByName === u.name).map(make) };
}

async function requisition(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  const since = recentSince();
  const rows = await prisma.stockRequisition.findMany({
    where: { OR: [...(perms.canApproveStock && perms.canAccessStock ? [{ status: 'Pending', requestedByName: { not: u.name } }] : []), { requestedByName: u.name, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    include: { lines: { include: { material: true } }, material: true },
    orderBy: { id: 'desc' },
    take: 100,
  });
  const make = (r: (typeof rows)[number]): ApprovalItem => {
    const lines = r.lines.length ? r.lines.map((l) => `${l.material.name} × ${l.qty}`) : r.material && r.qty ? [`${r.material.name} × ${r.qty}`] : [];
    const est = r.lines.reduce((a, l) => a + (l.estUnitCost ?? 0) * l.qty, 0);
    return {
      key: `requisition:${r.id}`,
      source: 'requisition',
      sourceLabel: SOURCE_LABEL.requisition,
      title: r.ref ?? `Requisition #${r.id}`,
      detail: `${lines.slice(0, 4).join(', ')}${lines.length > 4 ? ` and ${lines.length - 4} more` : ''}${r.note ? `. ${r.note}` : ''}`,
      amount: est > 0 ? r2(est) : null,
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt.toISOString(),
      status: r.status,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      note: null,
      link: '/stock',
      decide: { approve: `/stock/requisitions/${r.id}/approve`, reject: `/stock/requisitions/${r.id}/reject`, needsReason: false },
    };
  };
  return { waiting: rows.filter((r) => r.status === 'Pending' && r.requestedByName !== u.name).map(make), mine: rows.filter((r) => r.requestedByName === u.name).map(make) };
}

async function leave(u: Who, perms: Awaited<ReturnType<typeof permissionsForRole>>): Promise<Part> {
  const since = recentSince();
  const rows = await prisma.leaveRequest.findMany({
    where: { OR: [...(perms.canManageHr ? [{ status: 'Pending', staffId: { not: u.id } }] : []), { staffId: u.id, OR: [{ status: 'Pending' }, { decidedAt: { gte: since } }] }] },
    orderBy: { id: 'desc' },
    take: 100,
  });
  if (!rows.length) return { waiting: [], mine: [] };
  const [people, types] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } }, select: { id: true, name: true } }),
    prisma.leaveType.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.leaveTypeId))] } }, select: { id: true, name: true } }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const make = (r: (typeof rows)[number]): ApprovalItem => ({
    key: `leave:${r.id}`,
    source: 'leave',
    sourceLabel: SOURCE_LABEL.leave,
    title: `${name.get(r.staffId) ?? 'Staff'} — ${typeName.get(r.leaveTypeId) ?? 'leave'}`,
    detail: `${r.days} working day${r.days === 1 ? '' : 's'}, ${r.startDate} to ${r.endDate}${r.reason ? `. ${r.reason}` : ''}`,
    amount: null,
    requestedByName: name.get(r.staffId) ?? '',
    requestedAt: r.createdAt.toISOString(),
    status: r.status,
    decidedByName: r.decidedByName || null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    note: r.decisionNote || null,
    link: '/hr',
    decide: null, // deciding leave can need a confirmation (cover below the minimum): it is done on the People (HR) page
  });
  return { waiting: rows.filter((r) => r.status === 'Pending' && r.staffId !== u.id).map(make), mine: rows.filter((r) => r.staffId === u.id).map(make) };
}

/** What waits for this person's decision, and how their own requests are going (newest first). */
export async function approvalsFor(u: Who): Promise<{ waiting: ApprovalItem[]; mine: ApprovalItem[] }> {
  const perms = await permissionsForRole(u.role);
  const parts = await Promise.all([costing(u, perms), artwork(u, perms), discount(u), amend(u, perms), deletion(u, perms), requisition(u, perms), leave(u, perms)]);
  const byTime = (a: ApprovalItem, b: ApprovalItem) => (a.requestedAt < b.requestedAt ? 1 : -1);
  return { waiting: parts.flatMap((p) => p.waiting).sort(byTime), mine: parts.flatMap((p) => p.mine).sort((a, b) => ((b.decidedAt ?? b.requestedAt) > (a.decidedAt ?? a.requestedAt) ? 1 : -1)) };
}

/** The menu badge: how many wait for this person, and when each of their own requests was decided (the screen counts the ones it has not shown yet). */
export async function approvalsSummary(u: Who): Promise<{ waiting: number; decided: string[] }> {
  const { waiting, mine } = await approvalsFor(u);
  return { waiting: waiting.length, decided: mine.filter((m) => decided(m.status) && m.decidedAt).map((m) => m.decidedAt!) };
}

// ── Emails to those who can decide ────────────────────────────────────────────────────────────────
/** The roles that can decide each kind of request: the same tests as the decision endpoint (Admin always can). */
const ROLE_WHERE: Record<Exclude<ApprovalSource, 'discount'>, Prisma.RoleWhereInput> = {
  costing: { canSeeCosts: true, OR: [{ canCaptureOrders: true }, { canAccessFinance: true }] },
  artwork: { canManageDtf: true },
  amend: { canAccessFinance: true },
  deletion: { canAccessFinance: true },
  requisition: { canApproveStock: true, canAccessStock: true },
  leave: { canManageHr: true },
};

/** Who can decide this kind of request, with an email address and still working here. */
export async function approverRecipients(source: ApprovalSource, except?: { id?: number; name?: string }) {
  const roles = source === 'discount' ? [...DISCOUNT_ROLES] : [...(await prisma.role.findMany({ where: ROLE_WHERE[source], select: { name: true } })).map((r) => r.name), 'Admin'];
  const users = await prisma.user.findMany({ where: { role: { in: roles }, active: true, email: { not: null } }, select: { id: true, name: true, email: true } });
  return users.filter((x) => x.email && x.id !== except?.id && x.name !== except?.name);
}

/**
 * Tells those who can decide that a request is waiting: an email each, when mail is set up and the switch under Approvals is on. It goes out a few seconds later (so the request is safely
 * saved first) and never holds up or fails the request itself.
 */
export function notifyApprovers(source: ApprovalSource, subject: string, text: string, from?: { id?: number; name?: string }): void {
  const timer = setTimeout(async () => {
    try {
      const setting = await prisma.setting.findUnique({ where: { id: 1 } });
      if (setting && setting.approvalEmails === false) return;
      const mailer = await getMailer();
      if (!mailer) return;
      const to = await approverRecipients(source, from);
      for (const r of to) {
        await mailer
          .sendMail({ to: r.email!, subject: `Approval needed: ${subject}`, text: `${text}\n\nOpen Approvals in the GLM POS to approve or turn it down.` })
          .catch(() => undefined);
      }
    } catch {
      /* a failed email is never a failed request */
    }
  }, 3000);
  timer.unref?.();
}

