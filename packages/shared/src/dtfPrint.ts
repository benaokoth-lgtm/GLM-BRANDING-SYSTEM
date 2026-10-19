// DTF / UV DTF artwork order as a list: one print is a length of film with the artworks arranged on it. The sales person enters the LENGTH OF FILM USED (that is what comes off the roll — the only film
// figure tracked) and the rows — client, an optional description, how many, the price of ONE artwork (the print only), and for DTF the heat press and where the garment comes from. The total of a row is
// worked out. There is no recommended price: the prices the sales person enters are the prices. Rows with the same client make that client's order; the film is drawn from the roll once, as the length
// entered, each client's order carrying its share by the number of artworks.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export interface ArtworkRow {
  /** Whose artworks these are; blank = the print's own client. */
  client: string;
  phone: string;
  /** What the artworks are, for the order line ("left chest", "back print"): optional. */
  label: string;
  qty: number;
  /** Ksh for ONE artwork of this row: the print only — the heat press and any garment are separate (below). */
  price: number;
  /** DTF: the heat press, Ksh for ONE artwork of this row (every artwork is pressed). UV DTF stickers are applied cold: 0. */
  press: number;
  /** DTF: the stock item (a cap, a polo shirt…) the artworks are pressed on when WE supply it — one for each artwork of the row — and its list price each; null = the client brought their own. */
  garmentId: number | null;
  garmentPrice: number;
}

export interface ArtworkClient {
  /** How the rows of one client are told apart (phone if there is one, else the name). */
  key: string;
  client: string;
  phone: string;
  rows: ArtworkRow[];
  pieces: number;
  /** The metres of film this client's order carries: a share of the length by their number of artworks (the shares add up to the length entered). */
  metres: number;
  /** What the client pays for all their rows, and how it splits: the artworks (print), the heat press and the garments we supplied. */
  amount: number;
  artworkAmount: number;
  pressAmount: number;
  garmentAmount: number;
}

export interface ArtworkListCalc {
  ok: boolean;
  problems: string[];
  pieces: number;
  metres: number;
  enteredTotal: number;
  clients: ArtworkClient[];
}

/** How a client is recognised across rows: the phone number if there is one, else the name, ignoring case and spaces. */
export function artworkClientKey(client: string, phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? `p:${digits.slice(-9)}` : `n:${client.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

const fin = (n: number) => (Number.isFinite(n) ? n : 0);
/** What one row comes to: how many × (the print + the heat press + the garment when we supply it). */
export const artworkRowTotal = (r: Pick<ArtworkRow, 'qty' | 'price' | 'press' | 'garmentId' | 'garmentPrice'>): number => r2(fin(r.qty) * (fin(r.price) + fin(r.press) + (r.garmentId ? fin(r.garmentPrice) : 0)));

/** `withPress`: DTF (true) — every artwork is heat pressed, so each row needs the heat press price, and may carry a garment from stock; UV DTF (false) is applied cold: neither. */
export function artworkListCalc(rows: ArtworkRow[], metres: number, defaultClient = '', defaultPhone = '', withPress = true): ArtworkListCalc {
  const problems: string[] = [];
  const live = rows.filter((r) => r.qty > 0 || r.price > 0 || r.press > 0 || r.label.trim() || r.client.trim());
  if (!(metres > 0)) problems.push('Enter the length of film used (m)');
  if (live.length === 0) problems.push('Add at least one row of artworks');
  live.forEach((r, i) => {
    const n = i + 1;
    if (!Number.isInteger(r.qty) || r.qty < 1) problems.push(`Row ${n}: enter how many artworks`);
    if (!(r.price > 0)) problems.push(`Row ${n}: enter the price of one artwork`);
    if (withPress && !(r.press > 0)) problems.push(`Row ${n}: enter the heat press price (every artwork is pressed)`);
    if (!withPress && (r.press > 0 || r.garmentId)) problems.push(`Row ${n}: a UV DTF sticker is applied cold — no heat press or garment`);
  });
  const valid = live.filter((r) => Number.isInteger(r.qty) && r.qty > 0);
  const pieces = valid.reduce((a, r) => a + r.qty, 0);
  const enteredTotal = r2(valid.reduce((a, r) => a + artworkRowTotal(r), 0));

  const groups = new Map<string, ArtworkClient>();
  for (const r of valid) {
    const client = r.client.trim() || defaultClient.trim();
    const phone = r.client.trim() ? r.phone.trim() : r.phone.trim() || defaultPhone.trim();
    const key = artworkClientKey(client, phone);
    const g = groups.get(key) ?? { key, client, phone, rows: [], pieces: 0, metres: 0, amount: 0, artworkAmount: 0, pressAmount: 0, garmentAmount: 0 };
    g.rows.push(r);
    g.pieces += r.qty;
    g.amount = r2(g.amount + artworkRowTotal(r));
    g.artworkAmount = r2(g.artworkAmount + r.qty * r.price);
    g.pressAmount = r2(g.pressAmount + r.qty * (withPress ? r.press : 0));
    g.garmentAmount = r2(g.garmentAmount + (r.garmentId ? r.qty * r.garmentPrice : 0));
    if (!g.phone && phone) g.phone = phone;
    groups.set(key, g);
  }
  const clients = [...groups.values()];
  // the film is shared by the number of artworks; the last client takes what is left so the shares add up to the length entered exactly
  let left = metres > 0 ? metres : 0;
  clients.forEach((g, i) => {
    g.metres = i === clients.length - 1 ? r3(left) : r3(pieces > 0 && metres > 0 ? (metres * g.pieces) / pieces : 0);
    left = r3(left - g.metres);
  });

  return { ok: problems.length === 0, problems, pieces, metres: metres > 0 ? metres : 0, enteredTotal, clients };
}
