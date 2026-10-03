import { Prisma } from '@prisma/client';
import {
  DEFAULT_ARTWORK_RATE_PCT,
  DEFAULT_FILM_BANDS,
  DEFAULT_GENERAL_BANDS,
  DEFAULT_OWNERSHIP_MONTHS,
  DEFAULT_ROLE_PERMISSIONS,
  VAT_RATE,
  artworkPremiumCommission,
  bandPosition,
  bandedAmount,
  bandsProblem,
  buildLineTotal,
  clientKeyFor,
  computeOrderTotals,
  filmPremiumCommission,
  filmPremiumPerM,
  ownershipEnd,
  round2,
  systemJobCalc,
  todayStr,
} from '@glm/shared';
import type { Band, LineItemInput } from '@glm/shared';
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

// ── Settings ────────────────────────────────────────────────────────────────

export interface CommissionConfig {
  generalBands: Band[];
  filmBands: Band[];
  artworkRatePct: number;
  ownershipMonths: number;
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
  };
}

// ── Who an order is credited to ─────────────────────────────────────────────

export interface Sourcing {
  salesSource: 'sourced' | 'house';
  sourcedByStaffId: number | null;
  clientKey: string | null;
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

/**
 * Decides who an order is credited to — called for every order as it is created.
 *   1. If the client is already credited to someone (their 12-month window is open), the order is credited to that person, whoever
 *      captures it. Nobody shares a client, so a second staff member claiming them changes nothing.
 *   2. Otherwise, if the person capturing says they sourced this client, the client becomes theirs from today for the window.
 *   3. Otherwise it is a house order and earns no sourcing commission.
 * A client with no phone, name or corporate account to recognise them by can never be owned.
 */
export async function resolveSourcing(
  db: Db,
  o: { corporateClientId?: number | null; phone?: string | null; name?: string | null; sourcedBy?: number | null },
): Promise<Sourcing> {
  const clientKey = clientKeyFor({ corporateClientId: o.corporateClientId, phone: o.phone, name: o.name });
  if (!clientKey) return { salesSource: 'house', sourcedByStaffId: null, clientKey: null };
  const today = todayStr();
  const owner = await activeOwner(db, clientKey, today);
  if (owner) return { salesSource: 'sourced', sourcedByStaffId: owner.staffId, clientKey };
  if (o.sourcedBy) {
    const cfg = await getCommissionConfig(db);
    await db.clientOwner.create({
      data: {
        clientKey,
        clientName: (o.name ?? '').trim() || (o.corporateClientId ? `Corporate client #${o.corporateClientId}` : clientKey),
        staffId: o.sourcedBy,
        startDate: today,
        endDate: ownershipEnd(today, cfg.ownershipMonths),
        createdByName: 'Sourced at order capture',
      },
    });
    return { salesSource: 'sourced', sourcedByStaffId: o.sourcedBy, clientKey };
  }
  return { salesSource: 'house', sourcedByStaffId: null, clientKey };
}

/**
 * Checked before an order is created. Someone claiming a client as their own must have given a way to recognise that client again
 * (a corporate account or a phone number — a name alone is too easy to mistake for someone else), and may only claim for themselves
 * unless they manage commission. Returns an error message, or null when the claim is fine (or there is none).
 */
export async function claimProblem(
  user: { id: number; role: string },
  o: { corporateClientId?: number | null; phone?: string | null; name?: string | null; sourcedBy?: number | null },
): Promise<string | null> {
  if (!o.sourcedBy) return null;
  if (o.sourcedBy !== user.id && !(await canManageCommission(user.role))) return 'You can only claim a client for yourself';
  const key = clientKeyFor({ corporateClientId: o.corporateClientId, phone: o.phone, name: o.name });
  if (!key || key.startsWith('n:')) return "Enter the client's phone number so they can be credited to you and recognised on their next order";
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

export function blankStatement(staffId: number, staffName = ''): StaffStatement {
  return {
    staffId,
    staffName,
    total: 0,
    general: { received: 0, netSales: 0, commission: 0, band: { rate: 0, nextFrom: null, nextRate: null, toNext: null }, orders: [] },
    film: { commission: 0, sales: [] },
    artwork: { commission: 0, jobs: [] },
    productivity: { ordersCaptured: 0, ordersSourced: 0, sourcedValue: 0, filmSales: 0, filmMetres: 0, filmAvgPricePerM: null, filmAvgPremiumPerM: null, artworkJobs: 0, artworkPieces: 0, artworkExtraCharged: 0 },
  };
}

export function periodRange(period: string): { start: string; end: string } {
  return { start: `${period}-01`, end: `${period}-31` };
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

  const people = new Map<number, StaffStatement>();
  const who = (id: number) => {
    let s = people.get(id);
    if (!s) people.set(id, (s = blankStatement(id)));
    return s;
  };

  // Commission on money received
  for (const o of flowOrders) {
    const f = flows.get(o.id)!;
    const net = f.received - f.refunded;
    const total = orderTotal(o);
    const share = total > 0 ? net / total : 0;
    if (o.dtfFilmSale) {
      const s = o.dtfFilmSale;
      const full = filmPremiumCommission(s.metres, s.pricePerM, s.minPriceAtSale, config.filmBands, VAT_RATE);
      if (full > 0) {
        const c = round2(full * share);
        const st = who(o.staffId);
        st.film.commission = round2(st.film.commission + c);
        st.film.sales.push({ orderNo: o.orderNo, customer: customerOf(o), metres: s.metres, pricePerM: s.pricePerM, premiumPerM: filmPremiumPerM(s.pricePerM, s.minPriceAtSale), orderTotal: round2(total), moneyIn: round2(net), commission: c });
      }
    } else if (o.dtfArtworkJob) {
      const j = o.dtfArtworkJob;
      const sys = systemJobCalc({ id: '', rollId: j.rollId, jobOn: j.jobOn, client: j.client, runningMetres: j.runningMetres, pieces: j.pieces, fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob, minPricePerPieceAtJob: j.minPricePerPieceAtJob }).finalPerPiece;
      const charged = Math.max(sys, j.chargedPerPiece ?? sys);
      const full = artworkPremiumCommission(j.pieces, charged, sys, config.artworkRatePct, VAT_RATE);
      if (full > 0) {
        const c = round2(full * share);
        const st = who(o.staffId);
        st.artwork.commission = round2(st.artwork.commission + c);
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

  // The bands, once each person's month is known
  for (const st of people.values()) {
    st.general.netSales = round2(Math.max(0, st.general.received) / (1 + VAT_RATE));
    st.general.commission = bandedAmount(config.generalBands, st.general.netSales);
    st.general.band = bandPosition(config.generalBands, st.general.netSales);
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
