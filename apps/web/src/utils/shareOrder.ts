import { fmtDate, fmtKsh } from '@glm/shared';
import type { CompanySettings, OrderDetail } from '../api/models';

// Sending an order, an invoice or a quotation to the customer — by email (the A4 document itself) or WhatsApp (a message to their number).

/** What to call the document in buttons and messages. */
export function documentLabel(order: OrderDetail): 'quotation' | 'invoice' | 'order receipt' {
  if (order.status === 'Quote') return 'quotation';
  if (order.kind === 'walkin' && order.status === 'Order') return 'order receipt';
  return 'invoice';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const documentTitleCase = (order: OrderDetail) => cap(documentLabel(order));

/** The customer's name and phone as recorded on the order (a corporate client's, or the walk-in customer's). */
export function orderContact(order: OrderDetail): { name: string; phone: string; email: string } {
  if (order.kind === 'corporate') return { name: order.corporateClient?.name ?? '', phone: order.corporateClient?.phone ?? '', email: order.corporateClient?.email ?? '' };
  const name = order.customerName && order.customerName.trim().toLowerCase() !== 'walk-in' ? order.customerName : '';
  return { name, phone: order.phone ?? '', email: '' };
}

/**
 * The WhatsApp message: who it is from, what it is, the lines, the total and what is still owed, and how to reach the company. (WhatsApp's
 * click-to-chat link cannot attach a file, so the message carries the figures themselves; the A4 document goes by email or print.)
 */
export function whatsappMessage(order: OrderDetail, company: CompanySettings | null): string {
  const label = documentLabel(order);
  const who = orderContact(order).name;
  const lines = order.lineItems.slice(0, 10).map((li) => {
    const what = [li.serviceName, li.materialName].filter(Boolean).join(' + ') || 'Item';
    return `• ${li.qty} × ${what} — ${fmtKsh(li.lineTotal)}`;
  });
  if (order.lineItems.length > 10) lines.push(`• …and ${order.lineItems.length - 10} more`);
  const owes = order.totals.balanceDue > 0.009;
  const reach = [company?.companyPhone, company?.companyPhone2].filter((p): p is string => !!p && !!p.trim()).join(' / ');
  return [
    `Hello${who ? ` ${who}` : ''},`,
    '',
    `Here is your ${label} ${order.orderNo}${company?.companyName ? ` from ${company.companyName}` : ''}, dated ${fmtDate(order.createdDate)}:`,
    ...lines,
    '',
    `Total: ${fmtKsh(order.totals.grandTotal)}`,
    order.status === 'Quote' ? '' : owes ? `Paid: ${fmtKsh(order.totals.paidTotal)} · Balance due: ${fmtKsh(order.totals.balanceDue)}${order.dueDate ? ` (by ${fmtDate(order.dueDate)})` : ''}` : 'Paid in full — thank you!',
    '',
    reach ? `Questions? Call ${reach}.` : '',
    company?.website?.trim() ? company.website.trim() : '',
  ]
    .filter((l, i, all) => !(l === '' && (all[i - 1] === '' || i === all.length - 1)))
    .join('\n')
    .trim();
}
