import { GENERAL_ORDER_HEAD, PRINTING_PUBLICATIONS_HEAD, UV_DTF_HEAD, UV_PEN_SERVICE } from '@glm/shared';
import { ensureBusinessHeadsOnce } from './purchases';
import { prisma } from './db';

// Retiring the old per-sqm "Embroidery" service. Embroidery is now priced by stitch count (routes/embroidery.ts), so the older service — which priced a design
// by its area — is removed once, at the first start after that update. A service no order has used is deleted outright; one that has been sold is only
// RETIRED (taken off the price list and the order screens) because the orders that used it must keep their line.

export interface Removed {
  deleted: boolean;
  retired: boolean;
  /** How many order lines used it. */
  orders: number;
}

export async function removeService(id: number): Promise<Removed> {
  const orders = await prisma.orderLineItem.count({ where: { serviceId: id } });
  if (orders === 0) {
    try {
      await prisma.service.delete({ where: { id } });
      return { deleted: true, retired: false, orders: 0 };
    } catch {
      /* something else still points at it: retire it instead */
    }
  }
  await prisma.service.update({ where: { id }, data: { retired: true } });
  return { deleted: false, retired: true, orders };
}

let done: Promise<void> | null = null;

/** Runs once per start; the flag in Setting makes it once for good, so a service an Admin later creates called "Embroidery" is left alone. */
export function retireLegacyEmbroideryOnce(): Promise<void> {
  return (done ??= (async () => {
    const setting = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    if (setting.embroideryLegacyRetired) return;
    const legacy = await prisma.service.findFirst({ where: { name: 'Embroidery', soldViaDtfModule: false, retired: false } });
    if (legacy) {
      const r = await removeService(legacy.id);
      console.log(r.deleted ? 'Removed the old "Embroidery" service (no order had used it).' : `Retired the old "Embroidery" service (${r.orders} order lines keep it).`);
    }
    await prisma.setting.update({ where: { id: 1 }, data: { embroideryLegacyRetired: true } });
  })());
}

/**
 * "Contracted out" is no longer an option on the price list (Master Data) and the General Order no longer takes a supplier's quote. A service that an earlier version had marked that way
 * is put back to an ordinary service, once at every start (nothing can mark one again). The services made by Job Costing for a costed job (sold through their own screen) keep it:
 * that is how a captured costing is sent to its supplier.
 */
export async function clearContractedOutOnce(): Promise<void> {
  const r = await prisma.service.updateMany({ where: { outsourced: true, soldViaDtfModule: false }, data: { outsourced: false } });
  if (r.count) console.log(`${r.count} service${r.count === 1 ? ' was' : 's were'} no longer marked "contracted out" (the option has been removed).`);
}

/**
 * Where services made by the system belong in Sales by Business Head. UV pens are sold on the UV DTF screen and count under UV DTF Printing; costed business cards, eulogies, company
 * profiles and brochures count under Printing & Publications. Services made by an earlier version were put under UV Printing or General Order: those are moved, once at every start. A service
 * an Admin has since put under another head is left where they put it.
 */
export async function alignSystemHeadsOnce(): Promise<void> {
  await ensureBusinessHeadsOnce();
  const heads = new Map((await prisma.businessHead.findMany()).map((h) => [h.name, h.id]));
  const uvDtf = heads.get(UV_DTF_HEAD);
  const pub = heads.get(PRINTING_PUBLICATIONS_HEAD);
  // under no head, or under the head an earlier version chose
  const was = [heads.get('UV Printing'), heads.get(GENERAL_ORDER_HEAD)].filter((x): x is number => x !== undefined);
  const notYetMoved = { OR: [{ businessHeadId: null }, { businessHeadId: { in: was } }] };
  if (uvDtf) await prisma.service.updateMany({ where: { name: UV_PEN_SERVICE, ...notYetMoved }, data: { businessHeadId: uvDtf } });
  if (pub) {
    const names = ['Business cards', 'Eulogy', 'Company profile', 'Brochure'].map((n) => 'Costed job — ' + n);
    await prisma.service.updateMany({ where: { name: { in: names }, ...notYetMoved }, data: { businessHeadId: pub } });
  }
}
