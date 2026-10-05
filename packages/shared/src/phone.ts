/**
 * A phone number as WhatsApp's click-to-chat link wants it: digits only, with the country code and no leading zero or plus.
 * Kenyan numbers written the usual ways all work — 0797 785 033, 797785033, +254 797 785 033, 254797785033. Returns null when it cannot be a phone
 * number (too short or too long).
 */
export function whatsappNumber(raw: string | null | undefined, countryCode = '254'): string | null {
  let d = (raw ?? '').replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2); // 00254… as typed for international
  else if (d.startsWith('0') && d.length === 10) d = countryCode + d.slice(1); // 0797785033
  else if (d.length === 9 && /^[17]/.test(d)) d = countryCode + d; // 797785033
  return d.length >= 11 && d.length <= 15 ? d : null;
}
