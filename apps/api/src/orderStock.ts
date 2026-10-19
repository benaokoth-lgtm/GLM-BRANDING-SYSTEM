// Stock leaves the shelf when an order that sells a stock item is recorded. (Until now nothing reduced Material.stockQty on a sale: stock rose when a purchase was received and was set
// by a stock take, so on-hand figures only moved with those.) A quotation holds nothing: its stock is taken when it becomes an invoice. The order remembers that its stock was taken
// (Order.stockTaken) so it is taken once, put back once if the order is removed, and a return on an order from before this existed (stockTaken false) does not add back what was never taken.
// Selling more than is on the shelf is allowed — the count may simply not have been updated yet — and shows as a negative figure for the next stock take to settle.
import type { Prisma } from '@prisma/client';

/** Takes the stock of every stock item on the order, once. A quotation takes none. */
export async function takeOrderStock(tx: Prisma.TransactionClient, orderId: number): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lineItems: { select: { materialId: true, qty: true } } } });
  if (!order || order.stockTaken || order.status === 'Quote') return;
  for (const li of order.lineItems) {
    if (li.materialId && li.qty > 0) await tx.material.update({ where: { id: li.materialId }, data: { stockQty: { decrement: li.qty } } });
  }
  await tx.order.update({ where: { id: orderId }, data: { stockTaken: true } });
}

/** Puts back what takeOrderStock took, for an order that is being removed. */
export async function returnOrderStock(tx: Prisma.TransactionClient, orderId: number): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lineItems: { select: { materialId: true, qty: true } } } });
  if (!order || !order.stockTaken) return;
  for (const li of order.lineItems) {
    if (li.materialId && li.qty > 0) await tx.material.update({ where: { id: li.materialId }, data: { stockQty: { increment: li.qty } } });
  }
  await tx.order.update({ where: { id: orderId }, data: { stockTaken: false } });
}
