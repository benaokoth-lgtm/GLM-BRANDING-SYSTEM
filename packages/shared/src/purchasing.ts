// Purchases reconciliation — the pure rules, with no database in them.
//
// A requisition says what is wanted (a material, a quantity and an expected unit price). A purchase order says what was bought
// (quantity and the real unit price from the supplier's invoice). The store manager then enters what physically arrived. Three
// quantities and two prices, and the gaps between them are what the reconciliation report shows:
//
//   requisitioned qty → purchased (invoiced) qty → received-in-store qty        expected price → actual price
//
// The money gap is split into a PRICE variance and a QUANTITY variance that add up exactly to the total variance:
//   total variance      = actual total − expected total
//   price variance      = (actual unit − expected unit) × purchased qty
//   quantity variance   = (purchased qty − requisitioned qty) × expected unit
// because  a·p − e·r = (a − e)·p + (p − r)·e.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const formatPurchaseOrderRef = (n: number) => `PO-${String(n).padStart(4, '0')}`;

/** The next free purchase-order number given the references already issued ('PO-0007', …). */
export function nextPurchaseOrderNumber(refs: (string | null | undefined)[]): number {
  let highest = 0;
  for (const ref of refs) {
    const m = /^PO-(\d+)$/.exec(ref ?? '');
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest + 1;
}

export interface ReqLineInput {
  materialId: number;
  name: string;
  qty: number;
  /** The expected unit price entered on the requisition; null when nobody gave one. */
  estUnitCost: number | null;
}

export interface PurchaseLineInput {
  materialId: number;
  name: string;
  qty: number;
  unitCost: number;
  totalCost: number;
  /** What the store manager entered on receipt; null while the goods have not been received. */
  receivedQty: number | null;
  /** Held = bought, not yet received into the store. Accepted = received. (Rejected purchases are left out before this is called.) */
  status: 'Held' | 'Accepted';
}

export type ReconStatus = 'Not purchased' | 'Awaiting receipt' | 'Received' | 'Not requisitioned';

export interface ReconLine {
  materialId: number;
  name: string;
  status: ReconStatus;
  requisitionedQty: number;
  expectedUnitCost: number | null;
  expectedTotal: number | null;
  purchasedQty: number;
  receivedQty: number;
  actualUnitCost: number | null;
  actualTotal: number;
  /** received − requisitioned, once the line has been received (null before that). */
  qtyVariance: number | null;
  /** purchased − received: goods paid for that did not reach the store (0 when everything arrived). */
  shortDelivery: number;
  /** actual unit price − expected unit price (null when either is unknown). */
  priceVarianceUnit: number | null;
  /** Ksh value of the price difference on what was bought. */
  priceVarianceValue: number | null;
  /** Ksh value of buying more or less than was requisitioned, at the expected price. */
  qtyVarianceValue: number | null;
  /** actual total − expected total (= price value + quantity value). */
  totalVariance: number | null;
}

export interface ReconTotals {
  expectedTotal: number;
  actualTotal: number;
  totalVariance: number;
  priceVarianceValue: number;
  qtyVarianceValue: number;
  /** Lines with no expected price cannot be priced against; their cost is left out of the variance and counted here. */
  unpricedLines: number;
  shortDeliveryValue: number;
  linesNotPurchased: number;
  linesAwaitingReceipt: number;
}

/**
 * Lines up one requisition against the purchases made for it. `purchases` must exclude rejected ones. A material that was bought
 * but is not on the requisition shows as 'Not requisitioned' — an unrequested purchase is exactly what this report is meant to catch.
 */
export function reconcileRequisition(reqLines: ReqLineInput[], purchases: PurchaseLineInput[]): { lines: ReconLine[]; totals: ReconTotals } {
  const byMaterial = new Map<number, PurchaseLineInput[]>();
  for (const p of purchases) byMaterial.set(p.materialId, [...(byMaterial.get(p.materialId) ?? []), p]);

  const build = (materialId: number, name: string, reqQty: number, est: number | null, bought: PurchaseLineInput[]): ReconLine => {
    const purchasedQty = bought.reduce((a, p) => a + p.qty, 0);
    const actualTotal = r2(bought.reduce((a, p) => a + p.totalCost, 0));
    const anyHeld = bought.some((p) => p.status === 'Held');
    const receivedQty = bought.reduce((a, p) => a + (p.status === 'Accepted' ? (p.receivedQty ?? p.qty) : 0), 0);
    const acceptedQty = bought.filter((p) => p.status === 'Accepted').reduce((a, p) => a + p.qty, 0);
    const status: ReconStatus = reqQty === 0 ? 'Not requisitioned' : bought.length === 0 ? 'Not purchased' : anyHeld ? 'Awaiting receipt' : 'Received';
    const actualUnitCost = purchasedQty > 0 ? r2(actualTotal / purchasedQty) : null;
    const expectedTotal = est != null ? r2(est * reqQty) : null;
    const priced = est != null && purchasedQty > 0;
    const priceVarianceValue = priced ? r2(((actualTotal / purchasedQty) - est!) * purchasedQty) : null;
    const qtyVarianceValue = priced ? r2((purchasedQty - reqQty) * est!) : null;
    return {
      materialId,
      name,
      status,
      requisitionedQty: reqQty,
      expectedUnitCost: est,
      expectedTotal,
      purchasedQty,
      receivedQty,
      actualUnitCost,
      actualTotal,
      qtyVariance: status === 'Received' || status === 'Not requisitioned' ? r2(receivedQty - reqQty) : null,
      shortDelivery: r2(acceptedQty - receivedQty),
      priceVarianceUnit: actualUnitCost != null && est != null ? r2(actualUnitCost - est) : null,
      priceVarianceValue,
      qtyVarianceValue,
      totalVariance: priced ? r2(actualTotal - (expectedTotal ?? 0)) : null,
    };
  };

  const lines: ReconLine[] = [];
  const onReq = new Set<number>();
  for (const l of reqLines) {
    onReq.add(l.materialId);
    lines.push(build(l.materialId, l.name, l.qty, l.estUnitCost, byMaterial.get(l.materialId) ?? []));
  }
  for (const [materialId, bought] of byMaterial) {
    if (!onReq.has(materialId)) lines.push(build(materialId, bought[0]!.name, 0, null, bought));
  }

  const totals: ReconTotals = {
    expectedTotal: 0,
    actualTotal: 0,
    totalVariance: 0,
    priceVarianceValue: 0,
    qtyVarianceValue: 0,
    unpricedLines: 0,
    shortDeliveryValue: 0,
    linesNotPurchased: 0,
    linesAwaitingReceipt: 0,
  };
  for (const l of lines) {
    totals.actualTotal = r2(totals.actualTotal + l.actualTotal);
    if (l.status === 'Not purchased') totals.linesNotPurchased++;
    if (l.status === 'Awaiting receipt') totals.linesAwaitingReceipt++;
    totals.shortDeliveryValue = r2(totals.shortDeliveryValue + l.shortDelivery * (l.actualUnitCost ?? 0));
    if (l.totalVariance != null) {
      totals.expectedTotal = r2(totals.expectedTotal + (l.expectedTotal ?? 0));
      totals.totalVariance = r2(totals.totalVariance + l.totalVariance);
      totals.priceVarianceValue = r2(totals.priceVarianceValue + (l.priceVarianceValue ?? 0));
      totals.qtyVarianceValue = r2(totals.qtyVarianceValue + (l.qtyVarianceValue ?? 0));
    } else if (l.requisitionedQty > 0 && l.expectedUnitCost == null) {
      totals.unpricedLines++;
    }
  }
  // A material bought but never requisitioned has no expected price at all: its whole cost is unrequested spend.
  for (const l of lines) {
    if (l.status === 'Not requisitioned') {
      totals.totalVariance = r2(totals.totalVariance + l.actualTotal);
      totals.qtyVarianceValue = r2(totals.qtyVarianceValue + l.actualTotal);
    }
  }
  return { lines, totals };
}
