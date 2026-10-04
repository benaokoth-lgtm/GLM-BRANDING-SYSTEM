import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPurchaseOrderRef, nextPurchaseOrderNumber, reconcileRequisition, type PurchaseLineInput, type ReqLineInput } from '../src/purchasing.ts';

const req: ReqLineInput[] = [
  { materialId: 1, name: 'Caps', qty: 100, estUnitCost: 200 },
  { materialId: 2, name: 'Polo Shirts', qty: 50, estUnitCost: 600 },
  { materialId: 3, name: 'DTF film', qty: 10, estUnitCost: null },
];
const bought = (materialId: number, name: string, qty: number, unitCost: number, receivedQty: number | null, status: 'Held' | 'Accepted' = 'Accepted'): PurchaseLineInput => ({
  materialId, name, qty, unitCost, totalCost: qty * unitCost, receivedQty, status,
});

test('purchase order references count up from the highest issued', () => {
  assert.equal(formatPurchaseOrderRef(7), 'PO-0007');
  assert.equal(nextPurchaseOrderNumber([]), 1);
  assert.equal(nextPurchaseOrderNumber(['PO-0003', null, 'PO-0010', 'junk']), 11);
});

test('exactly as requisitioned: no variance anywhere', () => {
  const { lines, totals } = reconcileRequisition(req.slice(0, 2), [bought(1, 'Caps', 100, 200, 100), bought(2, 'Polo Shirts', 50, 600, 50)]);
  assert.equal(lines[0]!.status, 'Received');
  assert.equal(lines[0]!.qtyVariance, 0);
  assert.equal(lines[0]!.priceVarianceUnit, 0);
  assert.equal(lines[0]!.totalVariance, 0);
  assert.equal(totals.expectedTotal, 20000 + 30000);
  assert.equal(totals.actualTotal, 50000);
  assert.equal(totals.totalVariance, 0);
});

test('price and quantity variances add up exactly to the total variance', () => {
  // Caps: asked for 100 @200 = 20,000; bought 120 @210 = 25,200 → total +5,200
  //   price  = (210 − 200) × 120 = 1,200     quantity = (120 − 100) × 200 = 4,000
  const { lines, totals } = reconcileRequisition([req[0]!], [bought(1, 'Caps', 120, 210, 120)]);
  const l = lines[0]!;
  assert.equal(l.totalVariance, 5200);
  assert.equal(l.priceVarianceValue, 1200);
  assert.equal(l.qtyVarianceValue, 4000);
  assert.equal(l.priceVarianceValue! + l.qtyVarianceValue!, l.totalVariance);
  assert.equal(l.priceVarianceUnit, 10);
  assert.equal(l.qtyVariance, 20);
  assert.equal(totals.totalVariance, 5200);
  assert.equal(totals.priceVarianceValue + totals.qtyVarianceValue, totals.totalVariance);
});

test('buying less and cheaper gives negative variances', () => {
  const { lines } = reconcileRequisition([req[1]!], [bought(2, 'Polo Shirts', 40, 580, 40)]);
  const l = lines[0]!;
  assert.equal(l.qtyVariance, -10);
  assert.equal(l.priceVarianceUnit, -20);
  assert.equal(l.priceVarianceValue, -800); // (580 − 600) × 40
  assert.equal(l.qtyVarianceValue, -6000); // (40 − 50) × 600
  assert.equal(l.totalVariance, 23200 - 30000);
});

test('what the store manager received can differ from what was invoiced', () => {
  // 100 caps bought and paid for, only 92 counted into the store
  const { lines, totals } = reconcileRequisition([req[0]!], [bought(1, 'Caps', 100, 200, 92)]);
  const l = lines[0]!;
  assert.equal(l.purchasedQty, 100);
  assert.equal(l.receivedQty, 92);
  assert.equal(l.qtyVariance, -8); // measured on what physically arrived
  assert.equal(l.shortDelivery, 8);
  assert.equal(l.totalVariance, 0); // but the money paid matches the requisition
  assert.equal(totals.shortDeliveryValue, 1600);
});

test('a line not yet bought, or bought but not yet received, has no received variance yet', () => {
  const none = reconcileRequisition([req[0]!], []);
  assert.equal(none.lines[0]!.status, 'Not purchased');
  assert.equal(none.lines[0]!.qtyVariance, null);
  assert.equal(none.totals.linesNotPurchased, 1);

  const held = reconcileRequisition([req[0]!], [bought(1, 'Caps', 100, 200, null, 'Held')]);
  assert.equal(held.lines[0]!.status, 'Awaiting receipt');
  assert.equal(held.lines[0]!.receivedQty, 0);
  assert.equal(held.lines[0]!.qtyVariance, null);
  assert.equal(held.totals.linesAwaitingReceipt, 1);
});

test('two purchases of the same material add together, at a weighted average price', () => {
  const { lines } = reconcileRequisition([req[0]!], [bought(1, 'Caps', 60, 200, 60), bought(1, 'Caps', 40, 215, 40)]);
  const l = lines[0]!;
  assert.equal(l.purchasedQty, 100);
  assert.equal(l.actualTotal, 12000 + 8600);
  assert.equal(l.actualUnitCost, 206);
  assert.equal(l.priceVarianceValue, 600);
});

test('no expected price: the line is flagged, not guessed at', () => {
  const { lines, totals } = reconcileRequisition([req[2]!], [bought(3, 'DTF film', 10, 5000, 10)]);
  assert.equal(lines[0]!.priceVarianceUnit, null);
  assert.equal(lines[0]!.totalVariance, null);
  assert.equal(lines[0]!.actualTotal, 50000);
  assert.equal(totals.unpricedLines, 1);
  assert.equal(totals.totalVariance, 0);
});

test('something bought that was never requisitioned shows up as unrequested spend', () => {
  const { lines, totals } = reconcileRequisition([req[0]!], [bought(1, 'Caps', 100, 200, 100), bought(9, 'Mugs', 24, 150, 24)]);
  const extra = lines.find((l) => l.materialId === 9)!;
  assert.equal(extra.status, 'Not requisitioned');
  assert.equal(extra.requisitionedQty, 0);
  assert.equal(extra.actualTotal, 3600);
  assert.equal(totals.totalVariance, 3600);
  assert.equal(totals.actualTotal, 20000 + 3600);
});
