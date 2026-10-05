// A staff member's name is captured as first name, middle name (optional) and surname; the full name used everywhere else ("name") is the three
// joined with single spaces.

export interface NameParts {
  firstName: string;
  middleName: string;
  lastName: string;
}

const tidy = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

/** "Grace" + "" + "Njeri" → "Grace Njeri"; "Grace" + "Wanjiru" + "Njeri" → "Grace Wanjiru Njeri". */
export function composeName(p: { firstName?: string | null; middleName?: string | null; lastName?: string | null }): string {
  return [tidy(p.firstName), tidy(p.middleName), tidy(p.lastName)].filter(Boolean).join(' ');
}

/**
 * Splits a name that was typed as one piece: the first word is the first name, the last word the surname, anything between is the middle name.
 * A single word is taken as the first name and leaves the surname empty (it still has to be completed).
 */
export function splitName(full: string | null | undefined): NameParts {
  const words = tidy(full).split(' ').filter(Boolean);
  if (words.length === 0) return { firstName: '', middleName: '', lastName: '' };
  if (words.length === 1) return { firstName: words[0]!, middleName: '', lastName: '' };
  return { firstName: words[0]!, middleName: words.slice(1, -1).join(' '), lastName: words[words.length - 1]! };
}
