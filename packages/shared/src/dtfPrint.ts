// DTF / UV DTF artwork order, remodelled: one print is a length of film with the artworks arranged on it. The sales person measures the length of film used and each size of artwork
// (width × height, cm), and lists the rows — client, size, how many, the price of ONE artwork (the heat press included) — and the total of each row is worked out. There is no recommended
// price: the prices the sales person enters are the prices. Rows with the same client make that client's order; the film is drawn from the roll once, as the length entered.
//
// What the measurements are for: the film area (length × film width) against the total area of the artworks, shown under DTF → Film layout for information only — how much of the film
// the artworks fill. Nothing is charged, blocked or paid on it.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export interface ArtworkRow {
  /** Whose artworks these are; blank = the print's own client. */
  client: string;
  phone: string;
  widthCm: number;
  heightCm: number;
  qty: number;
  /** Ksh for ONE artwork of this row: the print only — the heat press and any garment are separate (below). */
  price: number;
  /** DTF: the heat press, Ksh for ONE artwork of this row (every artwork is pressed). UV DTF stickers are applied cold: 0. */
  press: number;
  /** DTF: the stock item (a cap, a polo shirt…) the artworks are pressed on when WE supply it — one for each artwork of the row — and its list price each; null = the client brought their own. */
  garmentId: number | null;
  garmentPrice: number;
}

/** "5 × 5 cm", "10.5 × 8 cm". */
export const artworkSizeLabel = (widthCm: number, heightCm: number): string => `${trim(widthCm)} × ${trim(heightCm)} cm`;
const trim = (n: number) => String(r2(n));

export interface ArtworkClient {
  /** How the rows of one client are told apart (the same key the sheets use: phone if there is one, else the name). */
  key: string;
  client: string;
  phone: string;
  rows: ArtworkRow[];
  pieces: number;
  areaCm2: number;
  /** The metres of film this client's order carries: a share of the length by the AREA of their artworks (they add up to the length entered). */
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
  /** Things worth a second look that do not stop the print (e.g. artworks that add up to more than the film). */
  warnings: string[];
  pieces: number;
  metres: number;
  filmWidthCm: number;
  filmAreaCm2: number;
  artworkAreaCm2: number;
  /** Film area − artwork area (information only). */
  unfilledCm2: number;
  /** Artwork area ÷ film area, in percent. */
  efficiencyPct: number;
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
export const artworkRowArea = (r: Pick<ArtworkRow, 'widthCm' | 'heightCm' | 'qty'>): number => (r.widthCm > 0 && r.heightCm > 0 && r.qty > 0 ? r.widthCm * r.heightCm * r.qty : 0);

const MAX_SIDE_CM = 1000;

/** `withPress`: DTF (true) — every artwork is heat pressed, so each row needs the heat press price, and may carry a garment from stock; UV DTF (false) is applied cold: neither. */
export function artworkListCalc(rows: ArtworkRow[], metres: number, filmWidthCm: number, defaultClient = '', defaultPhone = '', withPress = true): ArtworkListCalc {
  const problems: string[] = [];
  const warnings: string[] = [];
  const live = rows.filter((r) => r.qty > 0 || r.price > 0 || r.press > 0 || r.widthCm > 0 || r.heightCm > 0 || r.client.trim());
  if (!(metres > 0)) problems.push('Enter the length of film used (m)');
  if (live.length === 0) problems.push('Add at least one row of artworks');
  live.forEach((r, i) => {
    const n = i + 1;
    if (!(r.widthCm > 0) || !(r.heightCm > 0)) problems.push(`Row ${n}: enter the width and height of the artwork (cm)`);
    else if (r.widthCm > MAX_SIDE_CM || r.heightCm > MAX_SIDE_CM) problems.push(`Row ${n}: a side of ${MAX_SIDE_CM} cm or more cannot be right`);
    else if (filmWidthCm > 0 && Math.min(r.widthCm, r.heightCm) > filmWidthCm + 0.001) problems.push(`Row ${n}: ${artworkSizeLabel(r.widthCm, r.heightCm)} does not fit the ${trim(filmWidthCm)} cm film`);
    if (!Number.isInteger(r.qty) || r.qty < 1) problems.push(`Row ${n}: enter how many artworks`);
    if (!(r.price > 0)) problems.push(`Row ${n}: enter the price of one artwork`);
    if (withPress && !(r.press > 0)) problems.push(`Row ${n}: enter the heat press price (every artwork is pressed)`);
    if (!withPress && (r.press > 0 || r.garmentId)) problems.push(`Row ${n}: a UV DTF sticker is applied cold — no heat press or garment`);
  });
  const valid = live.filter((r) => Number.isInteger(r.qty) && r.qty > 0 && r.widthCm > 0 && r.heightCm > 0);
  const pieces = valid.reduce((a, r) => a + r.qty, 0);
  const artworkAreaCm2 = valid.reduce((a, r) => a + artworkRowArea(r), 0);
  const enteredTotal = r2(valid.reduce((a, r) => a + artworkRowTotal(r), 0));

  const groups = new Map<string, ArtworkClient>();
  for (const r of valid) {
    const client = r.client.trim() || defaultClient.trim();
    const phone = r.client.trim() ? r.phone.trim() : r.phone.trim() || defaultPhone.trim();
    const key = artworkClientKey(client, phone);
    const g = groups.get(key) ?? { key, client, phone, rows: [], pieces: 0, areaCm2: 0, metres: 0, amount: 0, artworkAmount: 0, pressAmount: 0, garmentAmount: 0 };
    g.rows.push(r);
    g.pieces += r.qty;
    g.areaCm2 += artworkRowArea(r);
    g.amount = r2(g.amount + artworkRowTotal(r));
    g.artworkAmount = r2(g.artworkAmount + r.qty * r.price);
    g.pressAmount = r2(g.pressAmount + r.qty * (withPress ? r.press : 0));
    g.garmentAmount = r2(g.garmentAmount + (r.garmentId ? r.qty * r.garmentPrice : 0));
    if (!g.phone && phone) g.phone = phone;
    groups.set(key, g);
  }
  const clients = [...groups.values()];
  // the film is shared by the area of each client's artworks; the last client takes what is left so the shares add up to the length entered exactly
  let left = metres > 0 ? metres : 0;
  clients.forEach((g, i) => {
    g.metres = i === clients.length - 1 ? r3(left) : r3(artworkAreaCm2 > 0 && metres > 0 ? (metres * g.areaCm2) / artworkAreaCm2 : 0);
    left = r3(left - g.metres);
  });

  const filmAreaCm2 = metres > 0 && filmWidthCm > 0 ? metres * 100 * filmWidthCm : 0;
  if (filmAreaCm2 > 0 && artworkAreaCm2 > filmAreaCm2 + 0.5) warnings.push(`The artworks add up to ${r2(artworkAreaCm2 / 10000)} m², which is more than the ${r2(filmAreaCm2 / 10000)} m² of film used — check the sizes and the length.`);
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    pieces,
    metres: metres > 0 ? metres : 0,
    filmWidthCm,
    filmAreaCm2,
    artworkAreaCm2,
    unfilledCm2: filmAreaCm2 > 0 ? filmAreaCm2 - artworkAreaCm2 : 0,
    efficiencyPct: filmAreaCm2 > 0 ? r2((artworkAreaCm2 / filmAreaCm2) * 100) : 0,
    enteredTotal,
    clients,
  };
}

// ── Film layout (DTF → Film layout) ──────────────────────────────────────────

/** A job, as far as the layout figures need it. */
export interface LayoutJob {
  id: number | string;
  sheetId?: string | null;
  jobOn: string;
  rollId: string;
  runningMetres: number;
  /** Film width the artworks were laid out on (cm; 0 = not recorded) and the total area of the artworks measured (cm²). */
  filmWidthCm?: number;
  areaCm2?: number;
  capturedByName?: string;
}

export interface LayoutPrint {
  key: string;
  date: string;
  rollId: string;
  by: string;
  clients: number;
  metres: number;
  filmAreaCm2: number;
  artworkAreaCm2: number;
  unfilledCm2: number;
  efficiencyPct: number;
  /** The artworks add up to more than the film: a measurement is wrong somewhere. */
  suspicious: boolean;
}

/** One line for each print (the jobs of one sheet are one print) that has sizes recorded; earlier ones, with none, are left out. Newest first. */
export function layoutPrints(jobs: LayoutJob[]): LayoutPrint[] {
  const groups = new Map<string, LayoutJob[]>();
  for (const j of jobs) {
    if (!((j.filmWidthCm ?? 0) > 0 && (j.areaCm2 ?? 0) > 0)) continue;
    const key = j.sheetId ? `s:${j.sheetId}` : `j:${j.id}`;
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  const out: LayoutPrint[] = [];
  for (const [key, list] of groups) {
    const filmAreaCm2 = list.reduce((a, j) => a + j.runningMetres * 100 * (j.filmWidthCm ?? 0), 0);
    const artworkAreaCm2 = list.reduce((a, j) => a + (j.areaCm2 ?? 0), 0);
    const first = list[0]!;
    out.push({
      key,
      date: first.jobOn,
      rollId: first.rollId,
      by: first.capturedByName ?? '',
      clients: list.length,
      metres: r3(list.reduce((a, j) => a + j.runningMetres, 0)),
      filmAreaCm2,
      artworkAreaCm2,
      unfilledCm2: filmAreaCm2 - artworkAreaCm2,
      efficiencyPct: filmAreaCm2 > 0 ? r2((artworkAreaCm2 / filmAreaCm2) * 100) : 0,
      suspicious: artworkAreaCm2 > filmAreaCm2 + 0.5,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export interface LayoutSummary {
  prints: number;
  metres: number;
  filmAreaCm2: number;
  artworkAreaCm2: number;
  unfilledCm2: number;
  efficiencyPct: number;
}

export function layoutSummary(prints: LayoutPrint[]): LayoutSummary {
  const filmAreaCm2 = prints.reduce((a, p) => a + p.filmAreaCm2, 0);
  const artworkAreaCm2 = prints.reduce((a, p) => a + p.artworkAreaCm2, 0);
  return {
    prints: prints.length,
    metres: r3(prints.reduce((a, p) => a + p.metres, 0)),
    filmAreaCm2,
    artworkAreaCm2,
    unfilledCm2: filmAreaCm2 - artworkAreaCm2,
    efficiencyPct: filmAreaCm2 > 0 ? r2((artworkAreaCm2 / filmAreaCm2) * 100) : 0,
  };
}

/** Square centimetres as square metres for display, two decimals. */
export const cm2ToM2 = (cm2: number): number => r2(cm2 / 10000);
