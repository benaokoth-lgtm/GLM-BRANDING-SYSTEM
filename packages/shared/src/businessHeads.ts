// Business heads — the lines of business income is reported under. Every service belongs to one; a material sold over the counter
// counts as General Order. The list can be edited in Master Data; these are the ones the business starts with.

export const GENERAL_ORDER_HEAD = 'General Order';

export const DEFAULT_BUSINESS_HEADS = ['DTF Printing', 'UV Printing', 'Laser Engraving', 'Large Format Printing', 'Embroidery', GENERAL_ORDER_HEAD] as const;

/** Which head a service falls under until someone chooses one: picked from its name, General Order when nothing fits. */
export function defaultBusinessHeadName(serviceName: string): string {
  const n = serviceName.toLowerCase();
  if (n.includes('dtf')) return 'DTF Printing';
  if (n.includes('embroid')) return 'Embroidery';
  if (n.includes('laser') || n.includes('engrav')) return 'Laser Engraving';
  if (/\buv\b/.test(n)) return 'UV Printing';
  if (/large[\s-]*format|banner|vinyl|flex\b|canvas|poster/.test(n)) return 'Large Format Printing';
  return GENERAL_ORDER_HEAD;
}
