// The two price lists (see packages/shared/src/priceList.ts): which one an order is captured under, who may use which, and the prices of each. GLM Sales is the price list as it has always been;
// Freelancer Sales is that list less one default percentage (Master Data → Service Price List), rounded, with any single price typed by hand winning.
import { PRICE_LIST_LABEL, clientKeyFor, freelancerPrice, priceListsFor } from '@glm/shared';
import type { DtfProduct, DtfSettings, PriceList } from '@glm/shared';
import { prisma } from './db';
import { activeOwner } from './commission';
import { permissionsForRole } from './permissions';

export interface PriceListConfig {
  discountPct: number;
  roundTo: number;
}

/** (inside a transaction, pass its client: a second connection would wait for the transaction to end) */
export async function priceListConfig(db: Pick<typeof prisma, 'setting'> = prisma): Promise<PriceListConfig> {
  const s = await db.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return { discountPct: s.freelancerDiscountPct, roundTo: s.freelancerRoundTo };
}

/** The price lists this role may capture under. */
export async function priceListsForRole(role: string): Promise<PriceList[]> {
  return priceListsFor(role, await permissionsForRole(role));
}

/** A catalogue price (a service or a material) on the Freelancer list: typed by hand, or the GLM price less the percentage. */
export function freelancerCatalogPrice(price: number, override: number | null | undefined, cfg: PriceListConfig): number {
  return freelancerPrice(price, cfg.discountPct, cfg.roundTo, override);
}

/** The price of a service or material on a list. */
export function priceOnList(item: { price: number; freelancerPriceOverride?: number | null }, list: PriceList, cfg: PriceListConfig): number {
  return list === 'freelancer' ? freelancerCatalogPrice(item.price, item.freelancerPriceOverride, cfg) : item.price;
}

/**
 * Which list an order is captured under, and whether it may be. `requested` is what the screen said (the menu it was keyed from); when a screen says nothing (an older screen) the list follows who the
 * order is credited to — a sales person's orders are Freelancer Sales, everyone else's GLM Sales — and nothing is refused. When it does say:
 *  • the person must be allowed that list (a sales person cannot use GLM Sales);
 *  • Freelancer Sales orders are credited to a sales person, so the front office must say which one;
 *  • GLM Sales orders are not credited to a sales person, and a client who belongs to a sales person's register is captured under Freelancer Sales (so it is credited to them at their prices).
 */
export async function resolvePriceList(
  user: { id: number; role: string },
  requested: unknown,
  staffId: number,
  client: { corporateClientId?: number | null; phone?: string | null; name?: string | null },
): Promise<{ ok: true; priceList: PriceList } | { ok: false; error: string }> {
  const credited = await prisma.user.findUnique({ where: { id: staffId }, select: { role: true } });
  const creditedIsSalesPerson = credited ? (await permissionsForRole(credited.role)).canBeAssignedOrders : false;
  if (requested !== 'glm' && requested !== 'freelancer') return { ok: true, priceList: creditedIsSalesPerson ? 'freelancer' : 'glm' };
  const list: PriceList = requested;
  const allowed = await priceListsForRole(user.role);
  if (!allowed.includes(list)) return { ok: false, error: `Your role captures orders under ${allowed.map((l) => PRICE_LIST_LABEL[l]).join(' or ') || 'neither list'}, not ${PRICE_LIST_LABEL[list]}` };
  if (list === 'freelancer') {
    if (!creditedIsSalesPerson) return { ok: false, error: 'Freelancer Sales orders are credited to a sales person — choose who this order is for' };
    return { ok: true, priceList: list };
  }
  if (creditedIsSalesPerson) return { ok: false, error: 'GLM Sales orders are not credited to a sales person — use Freelancer Sales for their orders' };
  const owned = await ownedClientProblem(client);
  if (owned) return { ok: false, error: owned };
  return { ok: true, priceList: list };
}

/** A client who is in a sales person's Client Register cannot be captured under GLM Sales: the order is theirs, at Freelancer prices. */
export async function ownedClientProblem(client: { corporateClientId?: number | null; phone?: string | null; name?: string | null }): Promise<string | null> {
  const key = clientKeyFor(client);
  if (!key || !(key.startsWith('p:') || key.startsWith('c:'))) return null;
  const owner = await activeOwner(prisma, key);
  return owner ? `This client is in ${owner.staffName}'s Client Register — capture the order under Freelancer Sales, so it is credited to them at Freelancer prices` : null;
}

// ── DTF / UV DTF rates per list ─────────────────────────────────────────────

const DTF_PRICE_FIELDS = ['stdPricePerM', 'minPricePerM', 'fixedChargePerMetre', 'minPricePerPiece', 'smallShareBelow', 'smallSharePrice'] as const;
export type DtfPriceField = (typeof DTF_PRICE_FIELDS)[number];
export const dtfFreelancerId = (product: DtfProduct) => (product === 'uv' ? 2 : 1);

/** The Freelancer rates typed by hand for a product (a blank follows the GLM rate less the percentage). */
export async function dtfFreelancerOverrides(product: DtfProduct) {
  return prisma.dtfFreelancerSetting.findUnique({ where: { id: dtfFreelancerId(product) } });
}

/** The rates of a product on a list: GLM as saved, or Freelancer — each money rate typed by hand or the GLM rate less the percentage, rounded. Roll size, width and wastage are the same for both. */
export async function dtfSettingsOnList(glm: DtfSettings, product: DtfProduct, list: PriceList): Promise<DtfSettings> {
  if (list !== 'freelancer') return glm;
  const [cfg, over] = await Promise.all([priceListConfig(), dtfFreelancerOverrides(product)]);
  const out: DtfSettings = { ...glm };
  for (const f of DTF_PRICE_FIELDS) out[f] = freelancerPrice(glm[f], cfg.discountPct, cfg.roundTo, over?.[f] ?? null);
  return out;
}
