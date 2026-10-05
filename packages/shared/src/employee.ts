// Statutory identifiers captured for each employee (Compliance → Employees) and for the company: National ID, KRA PIN, SHIF registration number.
// Each `clean…` tidies what was typed and says what is wrong with it; an empty value is allowed (the identifier is simply not on file yet).

export interface Cleaned {
  value: string | null;
  error?: string;
}

/** A KRA PIN is a letter, nine digits and a letter — A123456789B (individuals start with A, companies with P). Stored in capitals. */
export function cleanKraPin(input: string | null | undefined): Cleaned {
  const v = (input ?? '').replace(/\s+/g, '').toUpperCase();
  if (!v) return { value: null };
  if (!/^[A-Z]\d{9}[A-Z]$/.test(v)) return { value: null, error: 'A KRA PIN is a letter, nine digits and a letter, like A123456789B' };
  return { value: v };
}

/** A Kenyan National ID number is 7 or 8 digits. */
export function cleanNationalId(input: string | null | undefined): Cleaned {
  const v = (input ?? '').replace(/[\s.-]+/g, '');
  if (!v) return { value: null };
  if (!/^\d{7,8}$/.test(v)) return { value: null, error: 'A National ID number is 7 or 8 digits' };
  return { value: v };
}

/** The SHIF (Social Health Authority) registration number as it appears on the member's record: letters, digits, dashes or slashes. */
export function cleanShifNumber(input: string | null | undefined): Cleaned {
  const v = (input ?? '').trim().replace(/\s+/g, '').toUpperCase();
  if (!v) return { value: null };
  if (!/^[A-Z0-9][A-Z0-9/-]{3,24}$/.test(v)) return { value: null, error: 'A SHIF number has 4 to 25 letters, digits, dashes or slashes' };
  return { value: v };
}
