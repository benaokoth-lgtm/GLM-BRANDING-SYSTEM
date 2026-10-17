import { useEffect, useState } from 'react';
import { HEAT_PRESS_FEE_OPTIONS, fmtKsh, fmtNum, sheetCalc, sheetClientKey } from '@glm/shared';
import type { DtfProduct, SheetRow } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { useSalesPeople } from '../../hooks/useSalesPeople';
import { printOrderDocument } from '../../utils/printInvoice';
import type { CompanySettings, OrderDetail } from '../../api/models';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from '../SplitPayments';
import type { PaymentRow } from '../SplitPayments';
import { Corners, Field } from './shared';
import { usePriceList } from '../../state/PriceListContext';

// DTF / UV DTF artwork order, artworks of different sizes (and perhaps different clients) on one length of film. The sales person enters rows — a size, how many artworks, the price of each —
// and the rows must add up to at least the recommended total for the whole length, which is worked out the usual way: the fixed charge per metre shared by NUMBER of artworks, plus the
// minimum price of each. Rows can be priced differently (the large ones more, the small ones less); a client may pay less than their share when another pays more. Each client gets their own
// order, one line a size; the film comes off the roll once, as the metres entered. Commission is on what the whole sheet brings in above the recommended total.

export interface UiRow {
  key: number;
  client: string;
  label: string;
  qty: string;
  price: string;
}
let nextRowKey = 1;
export const newSheetRow = (): UiRow => ({ key: nextRowKey++, client: '', label: '', qty: '', price: '' });

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;
export const toSheetRows = (rows: UiRow[]): SheetRow[] => rows.map((r) => ({ client: r.client, phone: '', label: r.label, qty: Math.round(num(r.qty)), price: num(r.price) }));

interface PanelProps {
  rows: UiRow[];
  onChange: (rows: UiRow[]) => void;
  run: number;
  fixedChargePerMetre: number;
  minPricePerPiece: number;
  /** The recommended price of an artwork whose share of the film is below the lowest price (0 = none). */
  smallSharePrice?: number;
  smallShareBelow?: number;
  defaultClient: string;
  artworkRate: number | null;
  /** The artworks on the length, as entered beside the metres: the rows must add up to it. */
  pieces: number;
}

/** The rows of the sheet, and what they come to against the recommended total. */
export function ArtworkSheetPanel({ rows, onChange, run, fixedChargePerMetre, minPricePerPiece, smallSharePrice = 0, smallShareBelow = 0, defaultClient, artworkRate, pieces: expected }: PanelProps) {
  const calc = sheetCalc(toSheetRows(rows), run, fixedChargePerMetre, minPricePerPiece, defaultClient || 'Walk-in', '', expected, smallSharePrice, smallShareBelow);
  const set = (key: number, patch: Partial<UiRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const rec = calc.recommendedPerPiece;
  // The artworks of all the rows can never be more than the length carries: a row takes at most what the others have left.
  const placed = rows.reduce((a, r) => a + Math.max(0, Math.floor(num(r.qty))), 0);
  const left = expected > 0 ? expected - placed : 0;
  const [capped, setCapped] = useState('');
  function setQty(key: number, raw: string) {
    const clean = raw.replace(/[^\d]/g, '');
    const others = rows.filter((r) => r.key !== key).reduce((a, r) => a + Math.max(0, Math.floor(num(r.qty))), 0);
    const room = Math.max(0, expected - others);
    const n = clean === '' ? 0 : Number(clean);
    if (expected > 0 && n > room) {
      set(key, { qty: String(room) });
      setCapped(room > 0 ? `The length carries ${fmtNum(expected)} artworks: only ${fmtNum(room)} are left for this row.` : `All ${fmtNum(expected)} artworks of the length are already placed in the other rows.`);
    } else {
      set(key, { qty: clean });
      setCapped('');
    }
  }
  return (
    <div style={{ marginTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
      <div className="note" style={{ margin: 0 }}>
        Share the {expected > 0 ? <b>{fmtNum(expected)} artworks</b> : 'artworks'} of this length into rows, one for each size: how many, and the price of each. The rows must add up to at least the recommended total for the whole length
        {calc.pieces > 0 && run > 0 ? <> — about <b>{fmtKsh(rec)}</b> an artwork if they were all charged alike</> : ''}. Name the client on a row to give them their own order.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.1fr 0.7fr 0.8fr auto', gap: 6, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <span>Client</span>
        <span>Size / what</span>
        <span>How many</span>
        <span>Price each</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.1fr 0.7fr 0.8fr auto', gap: 6 }}>
          <input className="input" value={r.client} onChange={(e) => set(r.key, { client: e.target.value })} placeholder={defaultClient || 'Walk-in'} aria-label={`Row ${i + 1} client`} />
          <input className="input" value={r.label} onChange={(e) => set(r.key, { label: e.target.value })} placeholder="e.g. 5 × 5 cm" maxLength={80} aria-label={`Row ${i + 1} size`} />
          <input className="input" inputMode="numeric" value={r.qty} onChange={(e) => setQty(r.key, e.target.value)} placeholder="0" disabled={!(expected > 0)} title={expected > 0 ? '' : 'Enter the artworks on this length first'} aria-label={`Row ${i + 1} how many`} />
          <input className="input" inputMode="decimal" value={r.price} onChange={(e) => set(r.key, { price: e.target.value })} placeholder={rec > 0 ? String(rec) : 'Ksh'} aria-label={`Row ${i + 1} price each`} />
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
            ✕
          </button>
        </div>
      ))}
      {!(expected > 0) && <p className="note" style={{ margin: 0, color: 'var(--color-error)' }}>Enter the number of artworks on this length (above, beside the running metres) before placing them in rows.</p>}
      {expected > 0 && (
        <div className="note" style={{ margin: 0, fontWeight: 600, color: left === 0 ? 'var(--color-accent)' : undefined }}>
          {left > 0 ? `${fmtNum(left)} of the ${fmtNum(expected)} artworks still to place` : left === 0 ? `All ${fmtNum(expected)} artworks are placed` : `${fmtNum(-left)} too many`}
        </div>
      )}
      {capped && <p className="note" style={{ margin: 0, color: 'var(--color-error)' }}>{capped}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...rows, newSheetRow()])}>
          + Add a row
        </button>
        {rec > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" title="Fill every row that has no price with the recommended price" onClick={() => onChange(rows.map((r) => (r.price.trim() === '' ? { ...r, price: String(rec) } : r)))}>
            Use the recommended price where blank
          </button>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--color-divider)', marginTop: 4 }}>
        {(
          [
            ['Artworks placed in rows', expected > 0 ? `of the ${fmtNum(expected)} on ${fmtNum(run, 2)} m` : `on ${fmtNum(run, 2)} m`, fmtNum(calc.pieces)],
            ['Recommended total', `${fmtKsh(fixedChargePerMetre)}/m × ${fmtNum(run, 2)} m`, calc.pieces > 0 && run > 0 ? fmtKsh(calc.recommendedTotal) : '—'],
            ['Your total', 'the rows added up', fmtKsh(calc.enteredTotal)],
          ] as [string, string, string][]
        ).map(([l, fm, v]) => (
          <div key={l} style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 13 }}>
            <span style={{ flex: 1 }}>{l}</span>
            <span className="text-muted">{fm}</span>
            <b style={{ minWidth: 96, ...right }}>{v}</b>
          </div>
        ))}
        {calc.pieces > 0 && run > 0 && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) 2px', fontSize: 13, color: calc.surplus < -0.005 ? 'var(--color-error)' : undefined }}>
            <span style={{ flex: 1 }}>{calc.surplus < -0.005 ? 'Short of the recommended total' : 'Above the recommended total'}</span>
            <b style={{ minWidth: 96, ...right }}>{fmtKsh(Math.abs(calc.surplus))}</b>
          </div>
        )}
      </div>
      {calc.problems.map((p) => (
        <p key={p} className="note" style={{ margin: 0, color: 'var(--color-error)' }}>
          {p}
        </p>
      ))}
      {calc.ok && calc.clients.length > 1 && (
        <div style={{ fontSize: 13 }}>
          {calc.clients.map((c) => (
            <div key={c.key} style={{ display: 'flex', gap: 'var(--space-2)', padding: '3px 2px' }}>
              <span style={{ flex: 1 }}>{c.client || 'Walk-in'} · {fmtNum(c.pieces)} artworks · {fmtNum(c.metres, 3)} m of film</span>
              <span>{fmtKsh(c.amount)}</span>
              <span className="text-muted" style={{ minWidth: 150, ...right }}>{fmtNum(c.pctOfFairShare, 0)}% of their share</span>
            </div>
          ))}
        </div>
      )}
      {calc.ok && calc.surplus > 0.005 && artworkRate != null && (
        <p className="note" style={{ margin: 0, borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
          {fmtKsh(calc.surplus)} above the recommended total — worth about <b>{fmtKsh(Math.round((calc.surplus / 1.16) * (artworkRate / 100) * 100) / 100)}</b> commission to you, earned as the clients pay. Moving a price from one client to another earns nothing.
        </p>
      )}
    </div>
  );
}

interface DialogProps {
  product: DtfProduct;
  /** The artworks on the length, as entered beside the metres. */
  pieces: number;
  rollId: string;
  jobOn: string;
  run: number;
  rows: UiRow[];
  fixedChargePerMetre: number;
  minPricePerPiece: number;
  /** The recommended price of an artwork whose share of the film is below the lowest price (0 = none). */
  smallSharePrice?: number;
  smallShareBelow?: number;
  defaultClient: string;
  onClose: () => void;
  onDone: () => void;
}

/** Completes the sheet: the heat press fee, who it is credited to, each client's phone and what they pay now. Print records the orders — one for each client — and offers each one's receipt. */
export function ArtworkSheetDialog({ product, pieces: expected, rollId, jobOn, run, rows, fixedChargePerMetre, minPricePerPiece, smallSharePrice = 0, smallShareBelow = 0, defaultClient, onClose, onDone }: DialogProps) {
  const list = usePriceList(); // the price list the screen is under, for the orders
  const { user } = useAuth();
  const forOthers = user?.role === 'Admin' || !!user?.permissions.canCaptureForOthers;
  const salesPeople = useSalesPeople(forOthers);
  const [salesPersonId, setSalesPersonId] = useState<number | null>(null);
  const [heatPressFee, setHeatPressFee] = useState('');
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [pay, setPay] = useState<Record<string, PaymentRow[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<OrderDetail[] | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const noPress = product === 'uv';

  // clients are told apart by name here; once a phone is typed it tells them apart on the server
  const base = sheetCalc(toSheetRows(rows), run, fixedChargePerMetre, minPricePerPiece, defaultClient, '', expected, smallSharePrice, smallShareBelow);
  const nameKey = (client: string) => sheetClientKey(client, '');
  const withPhones = toSheetRows(rows).map((r) => {
    const c = r.client.trim() || defaultClient.trim();
    return { ...r, phone: phones[nameKey(c)] ?? '' };
  });
  const calc = sheetCalc(withPhones, run, fixedChargePerMetre, minPricePerPiece, defaultClient, '', expected, smallSharePrice, smallShareBelow);
  useEffect(() => {
    api.get<CompanySettings>('/master-data/settings').then(setCompany).catch(() => undefined);
  }, []);

  const feeNum = Number(heatPressFee) || 0;
  const totalOf = (amount: number, pieces: number) => Math.round((amount + feeNum * pieces) * 100) / 100;
  const rowsFor = (key: string) => pay[key] ?? [newPaymentRow()];
  const problem = base.clients
    .map((c) => paymentProblem(rowsFor(c.key), totalOf(c.amount, c.pieces)))
    .find((p) => !!p);
  const missingFee = !noPress && !(feeNum > 0);

  async function print() {
    setBusy(true);
    setError('');
    try {
      const clientPayments = base.clients.map((c) => ({ key: sheetClientKey(c.client, phones[c.key] ?? ''), payments: toApiPayments(rowsFor(c.key)) }));
      const r = await api.post<{ orders: OrderDetail[] }>('/dtf/sheets', {
        priceList: list,
        rollId,
        jobOn,
        client: defaultClient,
        runningMetres: run,
        pieces: expected,
        ...(noPress ? {} : { heatPressFee: feeNum }),
        rows: withPhones.map((x) => ({ client: x.client, phone: x.phone, label: x.label, qty: x.qty, price: x.price })),
        clientPayments,
        ...(forOthers && salesPersonId ? { staffId: salesPersonId } : {}),
      });
      setMade(r.orders);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record the sheet');
    } finally {
      setBusy(false);
    }
  }

  const receipt = (o: OrderDetail) => {
    const w = window.open('', '_blank');
    if (company) printOrderDocument(w, o, company);
    else w?.close();
  };

  return (
    <div className="dialog-backdrop" onClick={made ? undefined : onClose}>
      <div className="dialog blueprint" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <Corners />
        <div className="dialog-title">{made ? 'Sheet recorded' : 'Complete the artwork sheet'}</div>
        {made ? (
          <>
            <div className="dialog-body">
              <p style={{ marginTop: 0 }}>{made.length === 1 ? 'The order is recorded.' : `${made.length} orders are recorded, one for each client.`} The film comes off the roll once: {fmtNum(run, 2)} m.</p>
              {made.map((o) => (
                <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
                  <b>{o.orderNo}</b>
                  <span style={{ flex: 1 }}>{o.customerName || 'Walk-in'} · {fmtKsh(o.totals.grandTotal)}{o.totals.balanceDue > 0 ? ` · owes ${fmtKsh(o.totals.balanceDue)}` : ' · paid'}</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => receipt(o)}>
                    Print {o.totals.balanceDue > 0 ? 'invoice' : 'receipt'}
                  </button>
                </div>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary blueprint" onClick={onDone}>
                <Corners />
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-body">
              <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                {!noPress && (
                  <Field label="Heat press fee (Ksh/pc) — required">
                    <select className="input" value={heatPressFee} onChange={(e) => setHeatPressFee(e.target.value)} style={missingFee ? { borderColor: 'var(--color-error)' } : undefined}>
                      <option value="">Select a fee…</option>
                      {HEAT_PRESS_FEE_OPTIONS.map((fee) => (
                        <option key={fee} value={fee}>
                          Ksh {fee}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {forOthers && salesPeople.length > 0 && (
                  <Field label="Credit the sale to">
                    <select className="input" value={salesPersonId ?? ''} onChange={(e) => setSalesPersonId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">Me ({user?.name})</option>
                      {salesPeople.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {base.clients.map((c) => {
                  const total = totalOf(c.amount, c.pieces);
                  return (
                    <div key={c.key} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <b>{c.client || 'Walk-in'}</b>
                        <span>{fmtNum(c.pieces)} artworks · <b>{fmtKsh(total)}</b>{!noPress ? ' with the heat press fee' : ''}</span>
                      </div>
                      <div className="text-muted" style={{ fontSize: 12 }}>{c.rows.map((r) => `${r.qty} × ${r.label.trim() || 'artwork'} @ ${fmtKsh(r.price)}`).join(' · ')}</div>
                      <input className="input" placeholder="Phone (optional)" value={phones[c.key] ?? ''} onChange={(e) => setPhones({ ...phones, [c.key]: e.target.value })} aria-label={`Phone of ${c.client || 'Walk-in'}`} />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPay({ ...pay, [c.key]: [{ ...rowsFor(c.key)[0]!, amount: String(total) }] })}>
                          Pay in full
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPay({ ...pay, [c.key]: [newPaymentRow()] })}>
                          Pay later
                        </button>
                      </div>
                      <SplitPayments rows={rowsFor(c.key)} onChange={(r) => setPay({ ...pay, [c.key]: r })} total={total} phone={phones[c.key] ?? ''} accountReference={c.client || 'DTF sheet'} />
                    </div>
                  );
                })}
                {problem && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{problem}</p>}
                {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary blueprint" onClick={onClose} disabled={busy}>
                <Corners />
                Cancel
              </button>
              <button type="button" className="btn btn-primary blueprint" onClick={print} disabled={busy || !!problem || missingFee || !calc.ok}>
                <Corners />
                Record {base.clients.length > 1 ? `${base.clients.length} orders` : 'the order'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
