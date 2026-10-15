import { jobCalc } from './dtf';

// DTF / UV DTF artwork order with artworks of different sizes on one length of film, possibly for different clients ("a sheet"). The sales person enters rows — a size, how many artworks of it,
// and the price for each — and the system checks that the rows together bring in at least what the usual formula asks for the whole length:
//
//     recommended total = (minimum price per piece + fixed charge per metre × metres ÷ ALL the artworks) × all the artworks
//
// The cost is shared by NUMBER of artworks, not by their size, so the recommended price of every artwork is the same; the rows are free to charge sizes differently (the large ones more, the
// small ones less) as long as the total is not below the recommended total, and no row is below the minimum price for a piece. Rows with the same client make that client's order (one line per
// size); the film is taken from the roll once, as the metres entered, and each client's order carries its share of those metres by number of artworks. Prices are what the customer pays, VAT
// included, before the heat press fee.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface SheetRow {
  /** Whose artworks these are; blank = the sheet's own client. */
  client: string;
  phone: string;
  /** The size or what it is: "5 × 5 cm", "left chest". */
  label: string;
  qty: number;
  /** Ksh for one artwork of this row. */
  price: number;
}

export interface SheetClient {
  /** How the rows of one client are told apart. */
  key: string;
  client: string;
  phone: string;
  rows: SheetRow[];
  pieces: number;
  /** The metres of film this client's order carries (a share by number of artworks; they add up to the metres entered). */
  metres: number;
  /** What the client is charged for the artworks. */
  amount: number;
  /** What the same artworks cost at the recommended price. */
  fairShare: number;
  /** amount ÷ fairShare, in percent: below 100 this client pays less than their share and another pays more. */
  pctOfFairShare: number;
}

export interface SheetCalc {
  ok: boolean;
  problems: string[];
  pieces: number;
  metres: number;
  /** The recommended price of ONE artwork on this sheet. */
  recommendedPerPiece: number;
  recommendedTotal: number;
  enteredTotal: number;
  /** Entered − recommended: above 0 is earned above the recommendation; below 0 is not allowed. */
  surplus: number;
  clients: SheetClient[];
}

/** How a client is recognised across rows: the phone number if there is one, else the name, ignoring case and spaces. */
export function sheetClientKey(client: string, phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? `p:${digits.slice(-9)}` : `n:${client.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * `expectedPieces` is the number of artworks on the length as the sales person entered it (the number that, with the metres, gives the base price); when it is given the rows must add up to it,
 * so the recommended price every artwork is judged against is the one they saw. Left out, the rows themselves say how many there are.
 */
export function sheetCalc(rows: SheetRow[], metres: number, fixedChargePerMetre: number, minPricePerPiece: number, defaultClient = '', defaultPhone = '', expectedPieces = 0): SheetCalc {
  const problems: string[] = [];
  const live = rows.filter((r) => r.qty > 0 || r.price > 0 || r.label.trim() || r.client.trim());
  if (!(metres > 0)) problems.push('Enter the running metres');
  if (live.length === 0) problems.push('Add at least one row of artworks');
  live.forEach((r, i) => {
    const n = i + 1;
    if (!Number.isInteger(r.qty) || r.qty < 1) problems.push(`Row ${n}: enter how many artworks`);
    if (!(r.price >= minPricePerPiece - 0.005)) problems.push(`Row ${n}: the price of an artwork cannot be below the minimum of ${minPricePerPiece}`);
  });
  const pieces = live.reduce((a, r) => a + (Number.isInteger(r.qty) && r.qty > 0 ? r.qty : 0), 0);
  if (expectedPieces > 0 && pieces > 0 && pieces !== expectedPieces) problems.push(`The rows add up to ${pieces} artworks but the length has ${expectedPieces} — ${pieces < expectedPieces ? `${expectedPieces - pieces} still to place` : `${pieces - expectedPieces} too many`}`);
  // the recommended price is the one the sales person saw: worked out on the artworks entered beside the metres when they gave them
  const basis = expectedPieces > 0 ? expectedPieces : pieces;
  const rec = pieces > 0 && metres > 0 ? jobCalc(metres, basis, fixedChargePerMetre, minPricePerPiece) : { finalPerPiece: 0, jobTotal: 0 };
  const valid = live.filter((r) => Number.isInteger(r.qty) && r.qty > 0);
  const enteredTotal = r2(valid.reduce((a, r) => a + r.qty * r.price, 0));

  // group by client, in the order they first appear
  const groups = new Map<string, SheetClient>();
  for (const r of valid) {
    const client = r.client.trim() || defaultClient.trim();
    const phone = r.client.trim() ? r.phone.trim() : r.phone.trim() || defaultPhone.trim();
    const key = sheetClientKey(client, phone);
    const g = groups.get(key) ?? { key, client, phone, rows: [], pieces: 0, metres: 0, amount: 0, fairShare: 0, pctOfFairShare: 0 };
    g.rows.push(r);
    g.pieces += r.qty;
    g.amount = r2(g.amount + r.qty * r.price);
    if (!g.phone && phone) g.phone = phone;
    groups.set(key, g);
  }
  const clients = [...groups.values()];
  // the film is shared by number of artworks; the last client takes what is left so the shares add up to the metres entered exactly
  let left = metres;
  clients.forEach((g, i) => {
    g.metres = i === clients.length - 1 ? r2to(left) : r2to(pieces > 0 ? (metres * g.pieces) / pieces : 0);
    left -= g.metres;
    g.fairShare = basis > 0 ? r2((rec.jobTotal * g.pieces) / basis) : 0;
    g.pctOfFairShare = g.fairShare > 0 ? r2((g.amount / g.fairShare) * 100) : 0;
  });
  const surplus = r2(enteredTotal - rec.jobTotal);
  if (pieces > 0 && metres > 0 && surplus < -0.005) problems.push(`The artworks add up to ${enteredTotal}, which is ${r2(-surplus)} below the recommended total of ${rec.jobTotal} for this length. Raise some prices.`);
  return { ok: problems.length === 0, problems, pieces, metres, recommendedPerPiece: rec.finalPerPiece, recommendedTotal: rec.jobTotal, enteredTotal, surplus, clients };
}

/** Metres to three decimals. */
const r2to = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
