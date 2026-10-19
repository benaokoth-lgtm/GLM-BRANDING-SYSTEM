import { useEffect, useState } from 'react';
import { artworkClientKey, artworkListCalc, artworkRowTotal, artworkSizeLabel, cm2ToM2, fmtKsh, fmtNum } from '@glm/shared';
import type { ArtworkRow } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { useSalesPeople } from '../../hooks/useSalesPeople';
import { printOrderDocument } from '../../utils/printInvoice';
import type { CompanySettings, OrderDetail } from '../../api/models';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from '../SplitPayments';
import type { PaymentRow } from '../SplitPayments';
import { Corners, Field } from './shared';

// The DTF / UV DTF artwork order as a list. The sales person arranges the artworks on the film, measures the length of film used and each size (width × height, cm), and lists the rows:
// client, size, how many, the price of ONE artwork (the heat press included). The total of a row is worked out. There is no recommended price — these prices are the prices. Rows with the
// same client make that client's order. The film is drawn from the roll once, as the length entered; the sizes are kept so DTF → Film layout can show how much of the film the artworks fill.

export interface UiRow {
  key: number;
  client: string;
  width: string;
  height: string;
  qty: string;
  price: string;
}
let nextRowKey = 1;
export const newRow = (): UiRow => ({ key: nextRowKey++, client: '', width: '', height: '', qty: '', price: '' });

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
const right = { textAlign: 'right' } as const;
export const toRows = (rows: UiRow[]): ArtworkRow[] => rows.map((r) => ({ client: r.client, phone: '', widthCm: num(r.width), heightCm: num(r.height), qty: Math.round(num(r.qty)), price: num(r.price) }));

interface PanelProps {
  rows: UiRow[];
  onChange: (rows: UiRow[]) => void;
  /** The length of film used, in metres. */
  run: number;
  filmWidthCm: number;
  defaultClient: string;
}

/** The rows of the print and what they come to. */
export function ArtworkListPanel({ rows, onChange, run, filmWidthCm, defaultClient }: PanelProps) {
  const calc = artworkListCalc(toRows(rows), run, filmWidthCm, defaultClient || 'Walk-in', '');
  const set = (key: number, patch: Partial<UiRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const grid = '1.2fr 0.6fr 0.6fr 0.6fr 0.8fr 0.9fr auto';
  return (
    <div style={{ marginTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
      <div className="note" style={{ margin: 0 }}>
        List the artworks on this length: the client, the size you measured (width × height in cm), how many, and the price of <b>one</b> artwork <b>with the heat press included</b>. Name a client on a row to give them their own order.
        Rows of the same client go on one order. Every artwork in a row is taken to be the same size and price.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 6, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <span>Client</span>
        <span>Width cm</span>
        <span>Height cm</span>
        <span>How many</span>
        <span>Price each</span>
        <span style={right}>Total</span>
        <span />
      </div>
      {rows.map((r, i) => {
        const row = toRows([r])[0]!;
        return (
          <div key={r.key} style={{ display: 'grid', gridTemplateColumns: grid, gap: 6, alignItems: 'center' }}>
            <input className="input" value={r.client} onChange={(e) => set(r.key, { client: e.target.value })} placeholder={defaultClient || 'Walk-in'} aria-label={`Row ${i + 1} client`} />
            <input className="input" inputMode="decimal" value={r.width} onChange={(e) => set(r.key, { width: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" aria-label={`Row ${i + 1} width cm`} />
            <input className="input" inputMode="decimal" value={r.height} onChange={(e) => set(r.key, { height: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" aria-label={`Row ${i + 1} height cm`} />
            <input className="input" inputMode="numeric" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value.replace(/[^\d]/g, '') })} placeholder="0" aria-label={`Row ${i + 1} how many`} />
            <input className="input" inputMode="decimal" value={r.price} onChange={(e) => set(r.key, { price: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Ksh" aria-label={`Row ${i + 1} price each`} />
            <b style={right} aria-label={`Row ${i + 1} total`}>{row.qty > 0 && row.price > 0 ? fmtKsh(artworkRowTotal(row)) : '—'}</b>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
              ✕
            </button>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...rows, newRow()])}>
          + Add a row
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--color-divider)', marginTop: 4 }}>
        {(
          [
            ['Artworks', `${fmtNum(calc.clients.length)} ${calc.clients.length === 1 ? 'client' : 'clients'}`, fmtNum(calc.pieces)],
            ['Film used', `${fmtNum(run, 2)} m × ${fmtNum(filmWidthCm)} cm`, calc.filmAreaCm2 > 0 ? `${fmtNum(cm2ToM2(calc.filmAreaCm2), 2)} m²` : '—'],
            ['Artworks’ area', 'the sizes × how many', calc.artworkAreaCm2 > 0 ? `${fmtNum(cm2ToM2(calc.artworkAreaCm2), 2)} m²` : '—'],
            ['Film they fill', 'for information only', calc.filmAreaCm2 > 0 && calc.artworkAreaCm2 > 0 ? `${fmtNum(calc.efficiencyPct, 1)}%` : '—'],
          ] as [string, string, string][]
        ).map(([l, fm, v]) => (
          <div key={l} style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) 2px', borderBottom: '1px solid var(--color-divider)', fontSize: 13 }}>
            <span style={{ flex: 1 }}>{l}</span>
            <span className="text-muted">{fm}</span>
            <b style={{ minWidth: 96, ...right }}>{v}</b>
          </div>
        ))}
      </div>
      {calc.problems.map((p) => (
        <p key={p} className="note" style={{ margin: 0, color: 'var(--color-error)' }}>
          {p}
        </p>
      ))}
      {calc.warnings.map((p) => (
        <p key={p} className="note" style={{ margin: 0, color: 'var(--color-error)' }}>
          {p}
        </p>
      ))}
      {calc.ok && calc.clients.length > 1 && (
        <div style={{ fontSize: 13 }}>
          {calc.clients.map((c) => (
            <div key={c.key} style={{ display: 'flex', gap: 'var(--space-2)', padding: '3px 2px' }}>
              <span style={{ flex: 1 }}>{c.client || 'Walk-in'} · {fmtNum(c.pieces)} artworks · {fmtNum(c.metres, 3)} m of film</span>
              <b>{fmtKsh(c.amount)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DialogProps {
  rollId: string;
  jobOn: string;
  run: number;
  filmWidthCm: number;
  rows: UiRow[];
  defaultClient: string;
  onClose: () => void;
  onDone: () => void;
}

/** Completes the print: who it is credited to, each client's phone and what they pay now. Recording makes one order for each client and offers each one's receipt. */
export function ArtworkListDialog({ rollId, jobOn, run, filmWidthCm, rows, defaultClient, onClose, onDone }: DialogProps) {
  const { user } = useAuth();
  const forOthers = user?.role === 'Admin' || !!user?.permissions.canCaptureForOthers;
  const salesPeople = useSalesPeople(forOthers);
  const [salesPersonId, setSalesPersonId] = useState<number | null>(null);
  // the front office allocates every order (GLM or a sales person) before it is taken
  const [allocated, setAllocated] = useState(false);
  const allocationMissing = forOthers && salesPeople.length > 0 && !allocated;
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [pay, setPay] = useState<Record<string, PaymentRow[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<OrderDetail[] | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);

  // clients are told apart by name here; once a phone is typed it tells them apart on the server
  const base = artworkListCalc(toRows(rows), run, filmWidthCm, defaultClient, '');
  const nameKey = (client: string) => artworkClientKey(client, '');
  const withPhones = toRows(rows).map((r) => {
    const c = r.client.trim() || defaultClient.trim();
    return { ...r, phone: phones[nameKey(c)] ?? '' };
  });
  const calc = artworkListCalc(withPhones, run, filmWidthCm, defaultClient, '');
  useEffect(() => {
    api.get<CompanySettings>('/master-data/settings').then(setCompany).catch(() => undefined);
  }, []);

  const rowsFor = (key: string) => pay[key] ?? [newPaymentRow()];
  const problem = base.clients.map((c) => paymentProblem(rowsFor(c.key), c.amount)).find((p) => !!p);

  async function record() {
    setBusy(true);
    setError('');
    try {
      const clientPayments = base.clients.map((c) => ({ key: artworkClientKey(c.client, phones[c.key] ?? ''), payments: toApiPayments(rowsFor(c.key)) }));
      const r = await api.post<{ orders: OrderDetail[] }>('/dtf/prints', {
        rollId,
        jobOn,
        client: defaultClient,
        runningMetres: run,
        rows: withPhones.map((x) => ({ client: x.client, phone: x.phone, widthCm: x.widthCm, heightCm: x.heightCm, qty: x.qty, price: x.price })),
        clientPayments,
        ...(forOthers && salesPersonId ? { staffId: salesPersonId } : {}),
      });
      setMade(r.orders);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record the print');
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
        <div className="dialog-title">{made ? 'Print recorded' : 'Complete the artwork order'}</div>
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
                {forOthers && salesPeople.length > 0 && (
                  <Field label="Allocate the sale to">
                    <select
                      className="input"
                      value={!allocated ? '' : salesPersonId != null ? String(salesPersonId) : 'glm'}
                      aria-label="Allocate the sale to"
                      style={!allocated ? { borderColor: 'var(--color-error)' } : undefined}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAllocated(v !== '');
                        setSalesPersonId(v && v !== 'glm' ? Number(v) : null);
                      }}
                    >
                      {!allocated && <option value="">Allocate this sale to…</option>}
                      <option value="glm">GLM — the shop’s own sale (no sales person)</option>
                      {salesPeople.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {base.clients.map((c) => (
                  <div key={c.key} style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <b>{c.client || 'Walk-in'}</b>
                      <span>{fmtNum(c.pieces)} artworks · <b>{fmtKsh(c.amount)}</b> · {fmtNum(c.metres, 3)} m of film</span>
                    </div>
                    <div className="text-muted" style={{ fontSize: 12 }}>{c.rows.map((r) => `${r.qty} × ${artworkSizeLabel(r.widthCm, r.heightCm)} @ ${fmtKsh(r.price)}`).join(' · ')}</div>
                    <input className="input" placeholder="Phone (optional)" value={phones[c.key] ?? ''} onChange={(e) => setPhones({ ...phones, [c.key]: e.target.value })} aria-label={`Phone of ${c.client || 'Walk-in'}`} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPay({ ...pay, [c.key]: [{ ...rowsFor(c.key)[0]!, amount: String(c.amount) }] })}>
                        Pay in full
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPay({ ...pay, [c.key]: [newPaymentRow()] })}>
                        Pay later
                      </button>
                    </div>
                    <SplitPayments rows={rowsFor(c.key)} onChange={(r) => setPay({ ...pay, [c.key]: r })} total={c.amount} phone={phones[c.key] ?? ''} accountReference={c.client || 'DTF print'} />
                  </div>
                ))}
                {problem && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{problem}</p>}
                {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary blueprint" onClick={onClose} disabled={busy}>
                <Corners />
                Cancel
              </button>
              <button type="button" className="btn btn-primary blueprint" onClick={record} disabled={busy || !!problem || allocationMissing || !calc.ok}>
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
