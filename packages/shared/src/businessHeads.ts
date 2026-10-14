// Business heads — the lines of business income is reported under. Every service belongs to one; a material sold over the counter
// counts as General Order. The list can be edited in Master Data; these are the ones the business starts with.

export const GENERAL_ORDER_HEAD = 'General Order';

export const UV_DTF_HEAD = 'UV DTF Printing';

/** Costed print jobs: business cards, eulogy booklets, company profiles and brochures. */
export const PRINTING_PUBLICATIONS_HEAD = 'Printing & Publications';

export const DEFAULT_BUSINESS_HEADS = ['DTF Printing', UV_DTF_HEAD, 'UV Printing', 'Laser Engraving', 'Large Format Printing', 'Embroidery', PRINTING_PUBLICATIONS_HEAD, GENERAL_ORDER_HEAD] as const;

/** Which head a service falls under until someone chooses one: picked from its name, General Order when nothing fits. */
export function defaultBusinessHeadName(serviceName: string): string {
  const n = serviceName.toLowerCase();
  // UV pens are sold on the UV DTF screen and belong to UV DTF Printing
  if (/uv[\s-]*pen/.test(n)) return UV_DTF_HEAD;
  if (/^costed job\s*[—-]\s*(business cards|eulogy|company profile|brochure)/.test(n)) return PRINTING_PUBLICATIONS_HEAD;
  if (/uv[\s-]*dtf/.test(n)) return UV_DTF_HEAD;
  if (n.includes('dtf')) return 'DTF Printing';
  if (n.includes('embroid')) return 'Embroidery';
  if (n.includes('laser') || n.includes('engrav')) return 'Laser Engraving';
  if (/\buv\b/.test(n)) return 'UV Printing';
  if (/large[\s-]*format|banner|vinyl|flex\b|canvas|poster/.test(n)) return 'Large Format Printing';
  return GENERAL_ORDER_HEAD;
}
