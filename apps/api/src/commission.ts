import { Prisma } from '@prisma/client';
import {
  DEFAULT_ARTWORK_RATE_PCT,
  DEFAULT_FILM_BANDS,
  DEFAULT_GENERAL_BANDS,
  DEFAULT_FREELANCE_BANDS,
  DEFAULT_FREELANCE_WHT_RATE,
  DEFAULT_OWNERSHIP_MONTHS,
  DEFAULT_TARGET_MODE,
  DEFAULT_TARGET_MULTIPLIER,
  TARGET_MODES,
  DEFAULT_ROLE_PERMISSIONS,
  VAT_RATE,
  artworkPremiumCommission,
  bandPosition,
  bandedAmount,
  bandsProblem,
  buildLineTotal,
  clientKeyFor,
  isNamedClient,
  computeOrderTotals,
  filmPremiumCommission,
  filmPremiumPerM,
  ownershipEnd,
  freelanceSplit,
  DEFAULT_FREELANCE_PREMIUM_PCT,
  DEFAULT_FREELANCE_LOW_MARGIN_PCT,
  round2,
  weekEnd,
  salesTarget,
  withholdingOn,
  systemJobCalc,
  todayStr,
} from '@glm/shared';
import type { Band, FreelanceSplit, LineItemInput, SalesTarget, TargetMode } from '@glm/shared';
import { prisma } from './db';
import { permissionsForRole } from './permissions';

// Staff sales commission — the database side. The rules themselves (bands, premiums, the 12-month window) are in
// packages/shared/src/commission.ts; this file looks things up, credits orders to staff and builds each month's statement.
//
// Money is the trigger: commission is earned in the month the customer's money is RECEIVED, never when the order is raised.

type Db = Prisma.TransactionClient | typeof prisma;

export async function canManageCommission(role: string): Promise<boolean> {
  return role === 'Admin' || (await permissionsForRole(role)).canManageCommission;
}

/** Grants the permission once, on databases that pre-date it, to the roles that would normally have it. */
export async function ensureCommissionAccess(): Promise<void> {
  if ((await prisma.role.count({ where: { canManageCommission: true } })) > 0) return;
  for (const name of ['Finance Manager', 'General Manager']) {
    if (DEFAULT_ROLE_PERMISSIONS[name]?.canManageCommission) await prisma.role.updateMany({ where: { name }, data: { canManageCommission: true } });
  }
}
let ensuring: Promise<void> | null = null;
export function ensureCommissionAccessOnce(): Promise<void> {
  if (!ensuring) ensuring = ensureCommissionAccess().finally(() => (ensuring = null));
  return ensuring;
}

// ── The switch ──────────────────────────────────────────────────────────────

/** Is the commission scheme switched on? Off until an Admin switches it on (Master Data → Company Info). */
export async function commissionEnabled(db: Db = prisma): Promise<boolean> {
  return (await db.commissionSettings.findUnique({ where: { id: 1 }, select: { enabled: true } }))?.enabled ?? false;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface CommissionConfig {
  generalBands: Band[];
  filmBands: Band[];
  artworkRatePct: number;
  ownershipMonths: number;
  /** Freelance sales persons: marginal bands on their weekly net sales received at or above base prices. */
  freelanceBands: Band[];
  /** % of what was charged above base prices that a freelancer keeps. */
  freelancePremiumPct: number;
  /** The weight (%) at which the base part of contracted-out and stock lines counts towards the bands. */
  freelanceLowMarginPct: number;
  /** A freelancer keeps a client while an order comes in at least this often (months); every order restarts the count. */
  freelanceOwnershipMonths: number;
  /** The standard withholding tax rate (percent) deducted from freelance commission. */
  freelanceWhtRate: number;
  /** Times their basic monthly salary a person must sell before commission starts; 0 = no target. */
  targetMultiplier: number;
  targetMode: TargetMode;
}

function readBands(json: string | null | undefined, fallback: Band[]): Band[] {
  try {
    const v = JSON.parse(json ?? '');
    if (Array.isArray(v) && !bandsProblem(v, 'bands')) return v.map((b) => ({ from: Number(b.from), rate: Number(b.rate) })).sort((a, b) => a.from - b.from);
  } catch {
    /* fall through to the defaults */
  }
  return fallback;
}

/** The saved settings, or the defaults until someone saves some. Only reads, so it is safe inside a transaction. */
export async function getCommissionConfig(db: Db = prisma): Promise<CommissionConfig> {
  const row = await db.commissionSettings.findUnique({ where: { id: 1 } });
  return {
    generalBands: readBands(row?.generalBandsJson, DEFAULT_GENERAL_BANDS),
    filmBands: readBands(row?.filmBandsJson, DEFAULT_FILM_BANDS),
    artworkRatePct: row?.artworkRatePct ?? DEFAULT_ARTWORK_RATE_PCT,
    ownershipMonths: row?.ownershipMonths ?? DEFAULT_OWNERSHIP_MONTHS,
    freelanceBands: readBands(row?.freelanceBandsJson, DEFAULT_FREELANCE_BANDS),
    freelancePremiumPct: row?.freelancePremiumPct ?? DEFAULT_FREELANCE_PREMIUM_PCT,
    freelanceLowMarginPct: row?.freelanceLowMarginPct ?? DEFAULT_FREELANCE_LOW_MARGIN_PCT,
    freelanceOwnershipMonths: row?.freelanceOwnershipMonths ?? DEFAULT_OWNERSHIP_MONTHS,
    freelanceWhtRate: row?.freelanceWhtRate ?? DEFAULT_FREELANCE_WHT_RATE,
    targetMultiplier: row?.targetMultiplier ?? DEFAULT_TARGET_MULTIPLIER,
    targetMode: (TARGET_MODES as readonly string[]).includes(row?.targetMode ?? '') ? (row!.targetMode as TargetMode) : DEFAULT_TARGET_MODE,
  };
}

// ── Who an order is credited to ─────────────────────────────────────────────

export interface Sourcing {
  salesSource: 'sourced' | 'house' | 'freelance';
  sourcedByStaffId: number | null;
  clientKey: string | null;
  /** Set only when the order is marked for a freelance sales person — and then sourcedByStaffId is always null. */
  freelanceAgentId: number | null;
  freelanceQualifyingShare: number;
  freelanceBaseShare: number;
  freelanceLowShare: number;
  freelancePremiumShare: number;
}

export interface CreditLine {
  itemType: string;
  serviceId?: number | null;
  materialId?: number | null;
  qty: number;
  unitPrice: number;
  discountPct?: number;
  discountAmt?: number;
  heatPressFee?: number | null;
  artworkAreaSqm?: number | null;
  /** The base price of one unit when it is not simply the list price (film's floor, artwork's recommended price). */
  baseUnit?: number;
}

/**
 * The share of an order's value sold at or above base prices — only that share earns a freelance sales person commission. A line's base price is
 * the price-list price (a service's, a material's; for an artwork-sized line the area × the per-sqm rate), unless the caller gives its own.
 */
export async function freelanceShare(db: Db, lines: CreditLine[], orderDiscountPct = 0, orderDiscountAmt = 0): Promise<FreelanceSplit> {
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((v): v is number => !!v))];
  const materialIds = [...new Set(lines.map((l) => l.materialId).filter((v): v is number => !!v))];
  const services = new Map((serviceIds.length ? await db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, price: true, outsourced: true } }) : []).map((s) => [s.id, s]));
  const materials = new Map((materialIds.length ? await db.material.findMany({ where: { id: { in: materialIds } }, select: { id: true, price: true } }) : []).map((m) => [m.id, m.price]));
  return freelanceSplit(
    lines.map((l) => {
      const listed = l.serviceId ? (services.get(l.serviceId)?.price ?? 0) * (l.artworkAreaSqm && l.artworkAreaSqm > 0 ? l.artworkAreaSqm : 1) : l.materialId ? (materials.get(l.materialId) ?? 0) : 0;
      // a contracted-out service and stock resale carry a thin mark-up
      const lowMargin = l.serviceId ? !!services.get(l.serviceId)?.outsourced : !!l.materialId;
      return { qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, discountAmt: l.discountAmt, heatPressFee: l.heatPressFee, baseUnit: l.baseUnit ?? listed, lowMargin };
    }),
    orderDiscountPct,
    orderDiscountAmt,
  );
}

export interface OwnerInfo {
  id: number;
  staffId: number;
  staffName: string;
  startDate: string;
  endDate: string;
}

export async function activeOwner(db: Db, clientKey: string, today = todayStr()): Promise<OwnerInfo | null> {
  const row = await db.clientOwner.findFirst({
    where: { clientKey, status: 'Active', endDate: { gte: today } },
    include: { staff: { select: { name: true } } },
    orderBy: { id: 'desc' },
  });
  return row ? { id: row.id, staffId: row.staffId, staffName: row.staff.name, startDate: row.startDate, endDate: row.endDate } : null;
}

export interface FreelanceOwnerInfo {
  id: number;
  agentId: number;
  agentName: string;
  startDate: string;
  lastOrderDate: string;
  /** The last day the client stays theirs if no further order comes in. */
  until: string;
}

/** The freelance sales person who currently owns this client, if any: still within the window since their last order, and not suspended. */
export async function activeFreelanceOwner(db: Db, clientKey: string, today = todayStr(), months?: number): Promise<FreelanceOwnerInfo | null> {
  const window = months ?? (await getCommissionConfig(db)).freelanceOwnershipMonths;
  const rows = await db.freelanceClient.findMany({ where: { clientKey, status: 'Active' }, include: { agent: { select: { name: true, status: true } } }, orderBy: { id: 'desc' } });
  for (const r of rows) {
    const until = ownershipEnd(r.lastOrderDate, window);
    if (until >= today && r.agent.status !== 'Suspended') return { id: r.id, agentId: r.agentId, agentName: r.agent.name, startDate: r.startDate, lastOrderDate: r.lastOrderDate, until };
  }
  return null;
}

/** An order is being brought by this freelancer: the client becomes theirs (or, if it already is, the window restarts from today). */
async function takeFreelanceClient(db: Db, clientKey: string | null, agentId: number, label: string, today: string): Promise<void> {
  if (!clientKey) return;
  const existing = await db.freelanceClient.findFirst({ where: { clientKey, status: 'Active' }, orderBy: { id: 'desc' } });
  if (existing && existing.agentId === agentId) {
    await db.freelanceClient.update({ where: { id: existing.id }, data: { lastOrderDate: today } });
    return;
  }
  // (claimProblem has already refused a client that is still someone else's; what is left here has run out)
  if (existing) await db.freelanceClient.updateMany({ where: { clientKey, status: 'Active' }, data: { status: 'Lapsed' } });
  await db.freelanceClient.create({ data: { clientKey, clientName: label, agentId, startDate: today, lastOrderDate: today } });
}

/**
 * Decides who an order is credited to — called for every order as it is created. An order has exactly ONE credit holder:
 *   1. If the order is marked for a freelance sales person, it is credited to them alone (never to staff) and the client becomes theirs — it stays
 *      theirs for as long as they keep bringing orders (see activeFreelanceOwner).
 *   2. Otherwise, if the client is already credited to a staff member (their 12-month window is open), the order is credited to that person, whoever
 *      captures it. Nobody shares a client, so a second staff member claiming them changes nothing.
 *   3. Otherwise, if a freelance sales person owns the client, the order is credited to THEM, whoever captures it, and their window restarts.
 *   4. Otherwise, if the person capturing says they sourced this client, the client becomes theirs from today for the window.
 *   5. Otherwise it is a house order and earns no sourcing commission.
 * A client with no phone, name or corporate account to recognise them by can never be owned.
 */
export async function resolveSourcing(
  db: Db,
  o: {
    corporateClientId?: number | null;
    phone?: string | null;
    name?: string | null;
    sourcedBy?: number | null;
    /** The order is brought by this freelance sales person: it is credited to them and to NO staff member. */
    freelanceAgentId?: number | null;
    lines?: CreditLine[];
    orderDiscountPct?: number;
    orderDiscountAmt?: number;
  },
): Promise<Sourcing> {
  const house = { salesSource: 'house' as const, sourcedByStaffId: null, clientKey: null, freelanceAgentId: null, freelanceQualifyingShare: 1, freelanceBaseShare: 1, freelanceLowShare: 0, freelancePremiumShare: 0 };
  // Switched off: nobody is credited and no client is taken on.
  if (!(await commissionEnabled(db))) return house;
  const clientKey = clientKeyFor({ corporateClientId: o.corporateClientId, phone: o.phone, name: o.name });
  const today = todayStr();
  const label = (o.name ?? '').trim() || (o.corporateClientId ? `Corporate client #${o.corporateClientId}` : clientKey ?? '');
  const creditFreelancer = async (agentId: number): Promise<Sourcing> => {
    const split = o.lines && o.lines.length ? await freelanceShare(db, o.lines, o.orderDiscountPct ?? 0, o.orderDiscountAmt ?? 0) : { qualifying: 1, base: 1, low: 0, premium: 0 };
    return { salesSource: 'freelance', sourcedByStaffId: null, clientKey, freelanceAgentId: agentId, freelanceQualifyingShare: split.qualifying, freelanceBaseShare: split.base, freelanceLowShare: split.low, freelancePremiumShare: split.premium };
  };

  // Marked for a freelance account: credited to them alone, no staff member is credited, and the client becomes theirs.
  if (o.freelanceAgentId) {
    await takeFreelanceClient(db, clientKey, o.freelanceAgentId, label, today);
    return creditFreelancer(o.freelanceAgentId);
  }
  if (!clientKey) return { ...house };
  const owner = await activeOwner(db, clientKey, today);
  if (owner) return { ...house, salesSource: 'sourced', sourcedByStaffId: owner.staffId, clientKey };
  // A freelance sales person who keeps bringing this client owns them: every order from them is theirs, whoever captures it.
  const fo = await activeFreelanceOwner(db, clientKey, today);
  if (fo) {
    await db.freelanceClient.update({ where: { id: fo.id }, data: { lastOrderDate: today } });
    return creditFreelancer(fo.agentId);
  }
  if (o.sourcedBy) {
    const cfg = await getCommissionConfig(db);
    await db.clientOwner.create({
      data: {
        clientKey,
        clientName: label,
        staffId: o.sourcedBy,
        startDate: today,
        endDate: ownershipEnd(today, cfg.ownershipMonths),
        createdByName: 'Sourced at order capture',
      },
    });
    return { ...house, salesSource: 'sourced', sourcedByStaffId: o.sourcedBy, clientKey };
  }
  return { ...house, clientKey };
}

/**
 * Checked before an order is created. Someone claiming a client as their own must have given a way to recognise that client again
 * (a corporate account or a phone number — a name alone is too easy to mistake for someone else), and may only claim for themselves
 * unless they manage commission. Returns an error message, or null when the claim is fine (or there is none).
 */
export async function claimProblem(
  user: { id: number; role: string },
  o: { corporateClientId?: number | null; phone?: string | null; name?: string | null; sourcedBy?: number | null; freelanceAgentId?: number | null },
): Promise<string | null> {
  if (o.freelanceAgentId) {
    if (!(await commissionEnabled())) return null; // switched off: ignored, like a staff claim
    // One order, one owner: a staff claim and a freelance account cannot both be on the same order.
    if (o.sourcedBy) return 'An order is credited either to a staff member or to a freelance sales person — not both';
    const agent = await prisma.freelanceAgent.findUnique({ where: { id: o.freelanceAgentId } });
    if (!agent) return 'That freelance sales person does not exist';
    if (agent.status === 'Suspended') return `${agent.name} is suspended, so orders cannot be credited to them`;
    // The client must be recognisable next time — that is how they stay the freelancer's for as long as they keep bringing orders.
    const key = clientKeyFor({ corporateClientId: o.corporateClientId, phone: o.phone, name: o.name });
    if (!key || (!o.corporateClientId && (!key.startsWith('p:') || !isNamedClient(o.name)))) {
      return "Enter the client's name and phone number — they are needed to credit the client to the freelance sales person and to recognise them on their next order";
    }
    // A client a staff member already owns is theirs for the window: the order cannot also be given to a freelancer.
    const owner = await activeOwner(prisma, key);
    if (owner) return `This client is credited to ${owner.staffName} until ${owner.endDate}, so the order cannot also be credited to a freelance sales person`;
    // …and nor can one that another freelancer keeps bringing orders for.
    const fo = await activeFreelanceOwner(prisma, key);
    if (fo && fo.agentId !== o.freelanceAgentId) return `This client belongs to freelance sales person ${fo.agentName} (they keep bringing orders), so the order cannot be credited to someone else`;
    return null;
  }
  if (!o.sourcedBy) return null;
  if (!(await commissionEnabled())) return null; // switched off: a claim is simply ignored
  if (o.sourcedBy !== user.id && !(await canManageCommission(user.role))) return 'You can only claim a client for yourself';
  // Name and phone are optional on a walk-in sale — they become mandatory only here, when a client is being credited to someone.
  if (o.corporateClientId) return null;
  const key = clientKeyFor({ phone: o.phone, name: o.name });
  if (!key || !key.startsWith('p:') || !isNamedClient(o.name)) return "Enter the client's name and phone number so they can be credited to you and recognised on their next order";
  return null;
}

// ── The monthly statement ───────────────────────────────────────────────────

const orderInc = { lineItems: true, corporateClient: true, dtfFilmSale: true, dtfArtworkJob: true } satisfies Prisma.OrderInclude;
type StatementOrder = Prisma.OrderGetPayload<{ include: typeof orderInc }>;

const toInput = (li: StatementOrder['lineItems'][number]): LineItemInput => ({
  itemType: li.itemType as LineItemInput['itemType'],
  serviceId: li.serviceId,
  materialId: li.materialId,
  qty: li.qty,
  unitPrice: li.unitPrice,
  discountPct: li.discountPct,
  discountAmt: li.discountAmt,
  heatPressFee: li.heatPressFee ?? null,
});

const orderTotal = (o: StatementOrder) =>
  computeOrderTotals({ lineItems: o.lineItems.map(toInput), orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal;

const customerOf = (o: StatementOrder) => o.corporateClient?.name || o.customerName || 'Walk-in customer';

export interface StaffStatement {
  staffId: number;
  staffName: string;
  total: number;
  /** This month's sales measured against the sales target (3 × basic salary). Commission below is what is payable AFTER the target. */
  target: SalesTarget;
  /** What would have been paid on the month's sales had the target been met (shown, never paid, and not carried into the next month). Artwork is never held: it is earned whether or not the target is met. */
  heldCommission: number;
  general: {
    received: number; // money received this month on orders credited to this person (VAT included), less refunds of what had been paid
    netSales: number; // the same with the VAT taken out — what the bands apply to
    commission: number;
    band: { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null };
    orders: { orderNo: string; customer: string; received: number; refunded: number }[];
  };
  film: {
    commission: number;
    sales: { orderNo: string; customer: string; metres: number; pricePerM: number; premiumPerM: number; orderTotal: number; moneyIn: number; commission: number }[];
  };
  artwork: {
    commission: number;
    jobs: { orderNo: string; customer: string; pieces: number; systemPerPiece: number; chargedPerPiece: number; orderTotal: number; moneyIn: number; commission: number }[];
  };
  // How much they sold in the month (by the day the order was raised), whether or not it has been paid yet
  productivity: {
    ordersCaptured: number;
    ordersSourced: number;
    sourcedValue: number;
    filmSales: number;
    filmMetres: number;
    filmAvgPricePerM: number | null;
    filmAvgPremiumPerM: number | null;
    artworkJobs: number;
    artworkPieces: number;
    artworkExtraCharged: number; // KES charged above the recommended price (VAT incl.)
  };
}

export function blankStatement(staffId: number, staffName = '', target?: SalesTarget): StaffStatement {
  return {
    staffId,
    staffName,
    total: 0,
    target: target ?? salesTarget({ multiplier: DEFAULT_TARGET_MULTIPLIER, mode: DEFAULT_TARGET_MODE, salary: null, achieved: 0 }),
    heldCommission: 0,
    general: { received: 0, netSales: 0, commission: 0, band: { rate: 0, nextFrom: null, nextRate: null, toNext: null }, orders: [] },
    film: { commission: 0, sales: [] },
    artwork: { commission: 0, jobs: [] },
    productivity: { ordersCaptured: 0, ordersSourced: 0, sourcedValue: 0, filmSales: 0, filmMetres: 0, filmAvgPricePerM: null, filmAvgPremiumPerM: null, artworkJobs: 0, artworkPieces: 0, artworkExtraCharged: 0 },
  };
}

export function periodRange(period: string): { start: string; end: string } {
  return { start: `${period}-01`, end: `${period}-31` };
}

/**
 * Each person's basic monthly salary: the one recorded on their staff record (Compliance → Employees) or, failing that, their latest payroll
 * pay-run amount up to the end of the month. People with neither are left out — their commission is held until a salary is recorded.
 */
export async function salariesFor(staffIds: number[], endDate: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (staffIds.length === 0) return out;
  for (const u of await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, basicSalary: true } })) if (u.basicSalary && u.basicSalary > 0) out.set(u.id, u.basicSalary);
  const missing = staffIds.filter((id) => !out.has(id));
  if (missing.length) {
    const pay = await prisma.payrollEntry.findMany({ where: { staffId: { in: missing }, employeeType: 'Employee', date: { lte: endDate } }, orderBy: { date: 'desc' }, select: { staffId: true, grossPay: true } });
    for (const p of pay) if (!out.has(p.staffId) && p.grossPay > 0) out.set(p.staffId, p.grossPay);
  }
  return out;
}

/** One person's target for a month (used for the "my commission" page when they have not sold anything yet). */
export async function targetFor(staffId: number, period: string, config: CommissionConfig, achieved = 0): Promise<SalesTarget> {
  const salary = (await salariesFor([staffId], periodRange(period).end)).get(staffId) ?? null;
  return salesTarget({ multiplier: config.targetMultiplier, mode: config.targetMode, salary, achieved });
}

export async function buildStatements(period: string, only?: number): Promise<{ config: CommissionConfig; statements: StaffStatement[] }> {
  const { start, end } = periodRange(period);
  const config = await getCommissionConfig();
  const [payments, notes, raised] = await Promise.all([
    prisma.payment.findMany({ where: { date: { gte: start, lte: end } }, select: { orderId: true, amount: true } }),
    prisma.adjustmentNote.findMany({ where: { type: 'Credit', date: { gte: start, lte: end }, orderId: { not: null } }, select: { orderId: true, creditAmt: true } }),
    prisma.order.findMany({ where: { createdDate: { gte: start, lte: end }, status: { not: 'Quote' } }, include: orderInc }),
  ]);

  // Money in and refunds out, per order, this month
  const flows = new Map<number, { received: number; refunded: number }>();
  const flow = (id: number) => {
    let f = flows.get(id);
    if (!f) flows.set(id, (f = { received: 0, refunded: 0 }));
    return f;
  };
  for (const p of payments) flow(p.orderId).received += p.amount;
  for (const n of notes) if (n.orderId) flow(n.orderId).refunded += n.creditAmt;

  const orderIds = [...flows.keys()];
  const flowOrders = orderIds.length ? await prisma.order.findMany({ where: { id: { in: orderIds } }, include: orderInc }) : [];

  // Net sales (VAT out, money received) on the film and artwork orders each person captured — they count towards the sales target
  const dtfNet = new Map<number, number>();
  const addDtfNet = (id: number, net: number) => dtfNet.set(id, (dtfNet.get(id) ?? 0) + net / (1 + VAT_RATE));

  const people = new Map<number, StaffStatement>();
  const who = (id: number) => {
    let s = people.get(id);
    if (!s) people.set(id, (s = blankStatement(id)));
    return s;
  };

  // Commission on money received
  for (const o of flowOrders) {
    // An order credited to a freelance sales person is theirs alone: it earns no staff commission and counts towards no staff target.
    if (o.freelanceAgentId) continue;
    const f = flows.get(o.id)!;
    const net = f.received - f.refunded;
    const total = orderTotal(o);
    const share = total > 0 ? net / total : 0;
    if (o.dtfFilmSale) {
      const s = o.dtfFilmSale;
      const full = filmPremiumCommission(s.metres, s.pricePerM, s.minPriceAtSale, config.filmBands, VAT_RATE);
      if (full <= 0) addDtfNet(o.staffId, net);
      if (full > 0) {
        const c = round2(full * share);
        const st = who(o.staffId);
        st.film.commission = round2(st.film.commission + c);
        addDtfNet(o.staffId, net);
        st.film.sales.push({ orderNo: o.orderNo, customer: customerOf(o), metres: s.metres, pricePerM: s.pricePerM, premiumPerM: filmPremiumPerM(s.pricePerM, s.minPriceAtSale), orderTotal: round2(total), moneyIn: round2(net), commission: c });
      }
    } else if (o.dtfArtworkJob) {
      const j = o.dtfArtworkJob;
      const sys = systemJobCalc({ id: '', rollId: j.rollId, jobOn: j.jobOn, client: j.client, runningMetres: j.runningMetres, pieces: j.pieces, fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob, minPricePerPieceAtJob: j.minPricePerPieceAtJob }).finalPerPiece;
      const charged = Math.max(sys, j.chargedPerPiece ?? sys);
      const full = artworkPremiumCommission(j.pieces, charged, sys, config.artworkRatePct, VAT_RATE);
      if (full <= 0) addDtfNet(o.staffId, net);
      if (full > 0) {
        const c = round2(full * share);
        const st = who(o.staffId);
        st.artwork.commission = round2(st.artwork.commission + c);
        addDtfNet(o.staffId, net);
        st.artwork.jobs.push({ orderNo: o.orderNo, customer: customerOf(o), pieces: j.pieces, systemPerPiece: sys, chargedPerPiece: charged, orderTotal: round2(total), moneyIn: round2(net), commission: c });
      }
    } else if (o.channel !== 'dtf' && o.sourcedByStaffId && o.status !== 'Quote') {
      const st = who(o.sourcedByStaffId);
      st.general.received = round2(st.general.received + net);
      st.general.orders.push({ orderNo: o.orderNo, customer: customerOf(o), received: round2(f.received), refunded: round2(f.refunded) });
    }
  }

  // What each person sold this month, paid or not
  const base = new Map<number, { filmRevenue: number; filmPremium: number }>();
  for (const o of raised) {
    if (o.freelanceAgentId) continue;
    const cap = who(o.staffId).productivity;
    cap.ordersCaptured++;
    if (o.dtfFilmSale) {
      const s = o.dtfFilmSale;
      cap.filmSales++;
      cap.filmMetres = round2(cap.filmMetres + s.metres);
      const b = base.get(o.staffId) ?? { filmRevenue: 0, filmPremium: 0 };
      b.filmRevenue += s.metres * s.pricePerM;
      b.filmPremium += s.metres * filmPremiumPerM(s.pricePerM, s.minPriceAtSale);
      base.set(o.staffId, b);
    } else if (o.dtfArtworkJob) {
      const j = o.dtfArtworkJob;
      const sys = systemJobCalc({ id: '', rollId: j.rollId, jobOn: j.jobOn, client: j.client, runningMetres: j.runningMetres, pieces: j.pieces, fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob, minPricePerPieceAtJob: j.minPricePerPieceAtJob }).finalPerPiece;
      cap.artworkJobs++;
      cap.artworkPieces += j.pieces;
      cap.artworkExtraCharged = round2(cap.artworkExtraCharged + j.pieces * Math.max(0, (j.chargedPerPiece ?? sys) - sys));
    }
    if (o.sourcedByStaffId) {
      const src = who(o.sourcedByStaffId).productivity;
      src.ordersSourced++;
      src.sourcedValue = round2(src.sourcedValue + orderTotal(o));
    }
  }
  for (const [id, b] of base) {
    const p = people.get(id)!.productivity;
    p.filmAvgPricePerM = p.filmMetres > 0 ? round2(b.filmRevenue / p.filmMetres) : null;
    p.filmAvgPremiumPerM = p.filmMetres > 0 ? round2(b.filmPremium / p.filmMetres) : null;
  }

  // The bands, once each person's month is known — behind the sales target. Nothing is earned until a person has sold `multiplier` × their basic
  // salary in the month (net of VAT, money received); then the bands start at the target ('above') or apply to everything ('all').
  const salaries = await salariesFor([...people.keys()], end);
  for (const st of people.values()) {
    st.general.netSales = round2(Math.max(0, st.general.received) / (1 + VAT_RATE));
    const target = salesTarget({
      multiplier: config.targetMultiplier,
      mode: config.targetMode,
      salary: salaries.get(st.staffId) ?? null,
      achieved: st.general.netSales + (dtfNet.get(st.staffId) ?? 0),
    });
    st.target = target;
    const filmFull = st.film.commission;
    const artFull = st.artwork.commission;
    if (target.held) {
      // A month's target not met means no commission on that month's sales, and nothing rolls over to the next month. What they would have been
      // paid had the target been met is shown to them, not paid. The exception is artwork: the extra charged above the recommended price is
      // earned whether or not the target was met, so it stays in the total (and the sales still count towards the target).
      st.heldCommission = round2(filmFull + (config.targetMode === 'all' ? bandedAmount(config.generalBands, st.general.netSales) : 0));
      st.film.commission = 0;
      st.general.commission = 0;
    } else {
      st.general.commission = bandedAmount(config.generalBands, target.eligibleSales);
    }
    st.general.band = bandPosition(config.generalBands, target.eligibleSales);
    st.total = round2(st.general.commission + st.film.commission + st.artwork.commission);
  }

  const users = await prisma.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  const statements = [...people.values()]
    .map((s) => ({ ...s, staffName: names.get(s.staffId) ?? `Staff #${s.staffId}` }))
    .filter((s) => only === undefined || s.staffId === only)
    .sort((a, b) => b.total - a.total || a.staffName.localeCompare(b.staffName));
  return { config, statements };
}

// ── Freelance sales persons: the weekly statement ───────────────────────────

export interface FreelanceStatement {
  agentId: number;
  agentName: string;
  status: string;
  phone: string;
  mpesaNumber: string;
  /** How they like to be paid. */
  payMethod: string;
  kraPin: string;
  weekStart: string;
  weekEnd: string;
  /** Money received in the week on their orders (VAT included), less what was refunded. */
  received: number;
  /** Net of VAT, at or above base prices (base part + premium). */
  qualifyingNet: number;
  /** Net of VAT: the base-price part that the bands apply to, after the thin-margin weighting. */
  baseNet: number;
  /** Net of VAT charged above base prices on those lines: the premium. */
  premiumNet: number;
  /** The two parts of the commission. */
  baseCommission: number;
  premiumCommission: number;
  /** Net of VAT that did not qualify (sold below a base price): earns nothing. */
  belowBaseNet: number;
  commission: number;
  /** Withholding tax: the rate that applies to this person, the tax to deduct, and what they are paid after it. */
  whtRate: number;
  withholdingTax: number;
  netPay: number;
  band: { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null };
  orders: { orderNo: string; customer: string; orderTotal: number; moneyIn: number; qualifyingPct: number; qualifyingNet: number; premiumNet: number }[];
}

/**
 * Commission for each freelance sales person for one week (Monday to Sunday), on money RECEIVED that week on the orders credited to them,
 * net of VAT, and only the share of each order that was sold at or above base prices. Bands are marginal, on the week's total.
 */
export async function buildFreelanceStatements(weekStartDate: string, only?: number): Promise<{ config: CommissionConfig; statements: FreelanceStatement[] }> {
  const start = weekStartDate;
  const end = weekEnd(weekStartDate);
  const config = await getCommissionConfig();
  const [payments, notes] = await Promise.all([
    prisma.payment.findMany({ where: { date: { gte: start, lte: end }, order: { freelanceAgentId: { not: null } } }, select: { orderId: true, amount: true } }),
    prisma.adjustmentNote.findMany({ where: { type: 'Credit', date: { gte: start, lte: end }, orderId: { not: null } }, select: { orderId: true, creditAmt: true } }),
  ]);
  const flows = new Map<number, { received: number; refunded: number }>();
  const flow = (id: number) => {
    let f = flows.get(id);
    if (!f) flows.set(id, (f = { received: 0, refunded: 0 }));
    return f;
  };
  for (const p of payments) flow(p.orderId).received += p.amount;
  for (const n of notes) if (n.orderId) flow(n.orderId).refunded += n.creditAmt;
  const orders = flows.size ? await prisma.order.findMany({ where: { id: { in: [...flows.keys()] }, freelanceAgentId: only ?? { not: null } }, include: orderInc }) : [];

  const people = new Map<number, FreelanceStatement>();
  for (const o of orders) {
    const id = o.freelanceAgentId!;
    let st = people.get(id);
    if (!st) {
      st = { agentId: id, agentName: '', status: '', phone: '', mpesaNumber: '', payMethod: 'M-Pesa', kraPin: '', weekStart: start, weekEnd: end, received: 0, qualifyingNet: 0, baseNet: 0, premiumNet: 0, baseCommission: 0, premiumCommission: 0, belowBaseNet: 0, commission: 0, whtRate: 0, withholdingTax: 0, netPay: 0, band: { rate: 0, nextFrom: null, nextRate: null, toNext: null }, orders: [] };
      people.set(id, st);
    }
    const f = flows.get(o.id)!;
    const net = f.received - f.refunded;
    const share = o.freelanceQualifyingShare;
    const qual = (net * share) / (1 + VAT_RATE);
    // the order's qualifying part divides into the base price (banded; thin-margin lines at a reduced weight) and the premium above it (a share)
    const premiumShare = Math.min(share, Math.max(0, o.freelancePremiumShare));
    const baseShare = Math.min(share, Math.max(0, o.freelanceBaseShare));
    const lowShare = Math.min(baseShare, Math.max(0, o.freelanceLowShare));
    const weight = config.freelanceLowMarginPct / 100;
    const baseWeighted = (net * (baseShare - lowShare * (1 - weight))) / (1 + VAT_RATE);
    const prem = (net * premiumShare) / (1 + VAT_RATE);
    st.received = round2(st.received + net);
    st.qualifyingNet = round2(st.qualifyingNet + qual);
    st.baseNet = round2(st.baseNet + baseWeighted);
    st.premiumNet = round2(st.premiumNet + prem);
    st.belowBaseNet = round2(st.belowBaseNet + (net * (1 - share)) / (1 + VAT_RATE));
    st.orders.push({ orderNo: o.orderNo, customer: customerOf(o), orderTotal: round2(orderTotal(o)), moneyIn: round2(net), qualifyingPct: Math.round(share * 1000) / 10, qualifyingNet: round2(qual), premiumNet: round2(prem) });
  }
  for (const st of people.values()) {
    const basis = Math.max(0, st.baseNet);
    st.baseCommission = bandedAmount(config.freelanceBands, basis);
    st.premiumCommission = round2((Math.max(0, st.premiumNet) * config.freelancePremiumPct) / 100);
    st.commission = round2(st.baseCommission + st.premiumCommission);
    st.band = bandPosition(config.freelanceBands, basis);
  }
  const agents = await prisma.freelanceAgent.findMany({ where: { id: { in: [...people.keys()] } } });
  const byId = new Map(agents.map((a) => [a.id, a]));
  const statements = [...people.values()]
    .map((s) => {
      const a = byId.get(s.agentId);
      return { ...s, agentName: a?.name ?? `Agent #${s.agentId}`, status: a?.status ?? '', phone: a?.phone ?? '', mpesaNumber: a?.mpesaNumber || a?.phone || '', payMethod: a?.payMethod || 'M-Pesa', kraPin: a?.kraPin ?? '' };
    })
    .map((s) => {
      // tax is withheld from what they are paid: their own rate if they have one (0 = exempt), otherwise the standard rate
      const rate = byId.get(s.agentId)?.whtRate ?? config.freelanceWhtRate;
      const tax = withholdingOn(s.commission, rate);
      return { ...s, whtRate: rate, withholdingTax: tax, netPay: round2(s.commission - tax) };
    })
    .sort((a, b) => b.commission - a.commission || a.agentName.localeCompare(b.agentName));
  return { config, statements };
}
