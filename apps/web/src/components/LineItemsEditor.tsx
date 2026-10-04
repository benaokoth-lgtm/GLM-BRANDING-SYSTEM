import { useState } from 'react';
import { HEAT_PRESS_FEE_OPTIONS, buildLineTotal, fmtKsh, markupOf, priceFromCost } from '@glm/shared';
import { useAuth } from '../state/AuthContext';
import type { CatalogMaterial, CatalogService, DraftLineItem } from '../api/models';
import ArtworkSizeDialog from './ArtworkSizeDialog';
import ItemPicker from './ItemPicker';
import type { PickChoice } from './ItemPicker';

interface Props {
  lineItems: DraftLineItem[];
  services: CatalogService[];
  materials: CatalogMaterial[];
  onChange: (items: DraftLineItem[]) => void;
}

// A line is an item sold from the Stock Price List or a service from the Service Price List — never both. Selling and servicing the
// same physical item is two lines. A new line starts empty: pick what is being sold from the searchable list. A line with nothing
// picked is left out when the order is saved (see isBlankLine).
function defaultLine(_services: CatalogService[], _materials: CatalogMaterial[]): DraftLineItem {
  return {
    itemType: 'material',
    serviceId: null,
    materialId: null,
    qty: 1,
    unitPrice: '',
    discountPct: 0,
    discountAmt: 0,
    heatPressFee: '',
    artworkAreaSqm: '',
  };
}

/** True while nothing has been picked for the line. */
export function isBlankLine(li: DraftLineItem): boolean {
  return li.serviceId == null && li.materialId == null;
}

export function makeDefaultLine(services: CatalogService[], materials: CatalogMaterial[]): DraftLineItem {
  return defaultLine(services, materials);
}

// Per-piece price for an artwork-priced service (e.g. DTF Printing,
// Embroidery): a single artwork's area × the service's Ksh/sqm rate.
function computedUnitPrice(rate: number, areaSqm: number): number {
  return Math.round(rate * areaSqm * 100) / 100;
}

// A contracted-out service: the supplier quotes one VAT-inclusive price (paper and service together) and we add a mark-up. People who
// can see costs start from the service's usual quote and mark-up (the price follows from them); everyone else just gets the price list's
// selling price — the cost is recorded separately by someone who can see it.
function outsourcedPatch(sv: CatalogService | undefined, seeCosts: boolean): Partial<DraftLineItem> {
  const clear: Partial<DraftLineItem> = { supplierCost: '', markupType: 'percent', markupValue: '', supplierName: '' };
  if (!sv?.outsourced || !seeCosts) return clear;
  const type = sv.markupType === 'amount' ? 'amount' : 'percent';
  const cost = sv.defaultSupplierCost ?? 0;
  return {
    supplierName: sv.supplierName,
    supplierCost: cost > 0 ? cost : '',
    markupType: type,
    markupValue: sv.markupValue ?? 0,
    ...(cost > 0 ? { unitPrice: priceFromCost(cost, type, sv.markupValue ?? 0) } : {}),
  };
}

function initialUnitPriceFor(sv: CatalogService | undefined): number {
  // An artwork-priced service (DTF Printing, Embroidery) has no artwork
  // area yet on a fresh selection, so its per-piece price starts at 0
  // rather than the raw Ksh/sqm rate — it fills in once an area is entered.
  if (sv?.unit === 'sqm' && sv.usesArtworkPricing) return 0;
  return sv?.price ?? 0;
}

export default function LineItemsEditor({ lineItems, services, materials, onChange }: Props) {
  const [calcIdx, setCalcIdx] = useState<number | null>(null);
  const { user } = useAuth();
  const seeCosts = user?.role === 'Admin' || !!user?.permissions.canSeeCosts;

  function updateLine(idx: number, patch: Partial<DraftLineItem>) {
    const next = lineItems.slice();
    const current = next[idx];
    const merged: DraftLineItem = { ...current, ...patch };
    const sv = services.find((s) => s.id === merged.serviceId);

    // For an artwork-priced service (DTF Printing, Embroidery), a single
    // artwork's area × the service's Ksh/sqm rate gives the per-piece
    // price — recomputed whenever area changes, but only while still in
    // sync with what was last auto-computed (an explicit override to Unit
    // price always wins).
    if (sv?.usesArtworkPricing && sv.unit === 'sqm' && !('unitPrice' in patch)) {
      const area = Number(merged.artworkAreaSqm) || 0;
      const prevArea = Number(current.artworkAreaSqm) || 0;
      const priceInSync = current.unitPrice === '' || current.unitPrice == null || Number(current.unitPrice) === computedUnitPrice(sv.price, prevArea);
      if (priceInSync) merged.unitPrice = area > 0 ? computedUnitPrice(sv.price, area) : '';
    }

    // Outsourced: the selling price follows the supplier's quote and the mark-up, until someone types a price of their own.
    if (sv?.outsourced && seeCosts && !('unitPrice' in patch) && ('supplierCost' in patch || 'markupType' in patch || 'markupValue' in patch)) {
      const prev = priceFromCost(Number(current.supplierCost) || 0, current.markupType ?? 'percent', Number(current.markupValue) || 0);
      const inSync = current.unitPrice === '' || current.unitPrice == null || Number(current.unitPrice) === 0 || Number(current.unitPrice) === prev;
      const cost = Number(merged.supplierCost) || 0;
      if (inSync && cost > 0) merged.unitPrice = priceFromCost(cost, merged.markupType ?? 'percent', Number(merged.markupValue) || 0);
    }

    next[idx] = merged;
    onChange(next);
  }

  // Picking from the list decides what kind of line this is: an item from stock, a service, or (when the service is sold by the
  // metre) a per-metre service. Anything left over from a previous pick — artwork size, heat press fee, a supplier quote — is cleared.
  function handlePick(idx: number, choice: PickChoice) {
    if (choice.kind === 'material') {
      const mt = materials.find((m) => m.id === choice.id);
      updateLine(idx, { itemType: 'material', serviceId: null, materialId: choice.id, unitPrice: mt?.price ?? 0, artworkAreaSqm: '', heatPressFee: '', ...outsourcedPatch(undefined, seeCosts) });
    } else {
      const sv = services.find((s) => s.id === choice.id);
      updateLine(idx, {
        itemType: sv?.unit === 'metre' ? 'per-metre' : 'service',
        materialId: null,
        serviceId: choice.id,
        unitPrice: initialUnitPriceFor(sv),
        artworkAreaSqm: '',
        heatPressFee: '',
        ...outsourcedPatch(sv, seeCosts),
      });
    }
  }

  function addLine() {
    onChange([...lineItems, defaultLine(services, materials)]);
  }

  function removeLine(idx: number) {
    const next = lineItems.filter((_, i) => i !== idx);
    onChange(next.length ? next : [defaultLine(services, materials)]);
  }

  const subtotal = lineItems.reduce(
    (a, li) =>
      a +
      buildLineTotal({
        itemType: li.itemType,
        serviceId: li.serviceId,
        materialId: li.materialId,
        qty: Number(li.qty) || 0,
        unitPrice: Number(li.unitPrice) || 0,
        discountPct: Number(li.discountPct) || 0,
        discountAmt: Number(li.discountAmt) || 0,
        heatPressFee: Number(li.heatPressFee) || 0,
      }),
    0,
  );

  const missingArtworkArea = lineItems.some((li) => {
    const sv = services.find((s) => s.id === li.serviceId);
    return sv?.usesArtworkPricing && sv?.unit === 'sqm' && !(Number(li.artworkAreaSqm) > 0);
  });

  const missingPressingFee = lineItems.some((li) => {
    const sv = services.find((s) => s.id === li.serviceId);
    return sv?.chargesPressingFee && !(Number(li.heatPressFee) > 0);
  });

  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          opacity: 0.65,
          margin: 'var(--space-5) 0 var(--space-2)',
        }}
      >
        Line items
      </div>

      {lineItems.map((row, idx) => {
        const isMaterial = row.itemType === 'material';
        const rowService = services.find((sv) => sv.id === row.serviceId);
        const usesArtworkPricing = !isMaterial && !!rowService?.usesArtworkPricing && rowService?.unit === 'sqm';
        const chargesPressingFee = !isMaterial && !!rowService?.chargesPressingFee;
        const baseCols = '2.4fr 0.7fr 0.9fr 0.7fr 0.7fr';
        const extraCols = (usesArtworkPricing ? ' 0.9fr' : '') + (chargesPressingFee ? ' 0.9fr' : '');
        const cols = baseCols + extraCols + ' auto';
        const outsourced = !isMaterial && !!rowService?.outsourced;
        const quote = Number(row.supplierCost) || 0;
        const suggested = quote > 0 ? priceFromCost(quote, row.markupType ?? 'percent', Number(row.markupValue) || 0) : 0;
        const price = Number(row.unitPrice) || 0;
        const realised = quote > 0 && price > 0 ? markupOf(quote, price) : null;
        return (
        <div key={idx}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            gap: 'var(--space-2)',
            alignItems: 'end',
            padding: 'var(--space-2) 0',
            borderBottom: '1px solid var(--color-divider)',
          }}
        >
          <div className="field" style={{ margin: 0 }}>
            <label>Item or service</label>
            <ItemPicker
              services={services}
              materials={materials}
              selected={row.serviceId != null ? { kind: 'service', id: row.serviceId } : row.materialId != null ? { kind: 'material', id: row.materialId } : null}
              onPick={(choice) => handlePick(idx, choice)}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>{row.itemType === 'per-metre' ? 'Metres' : 'Qty'}</label>
            <input className="input" value={row.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} />
          </div>
          {usesArtworkPricing && (
            <div className="field" style={{ margin: 0 }}>
              <label>Artwork size (sqm)</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  className="input"
                  value={row.artworkAreaSqm}
                  onChange={(e) => updateLine(idx, { artworkAreaSqm: e.target.value })}
                  placeholder="e.g. 0.06"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Calculate from length × width"
                  title="Calculate from length × width"
                  onClick={() => setCalcIdx(idx)}
                >
                  📐
                </button>
              </div>
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>Unit price</label>
            <input className="input" value={row.unitPrice} onChange={(e) => updateLine(idx, { unitPrice: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Disc %</label>
            <input className="input" value={row.discountPct} onChange={(e) => updateLine(idx, { discountPct: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Disc Ksh</label>
            <input className="input" value={row.discountAmt} onChange={(e) => updateLine(idx, { discountAmt: e.target.value })} />
          </div>
          {chargesPressingFee && (
            <div className="field" style={{ margin: 0 }}>
              <label>Heat press fee (Ksh/pc)</label>
              <select className="input" value={row.heatPressFee} onChange={(e) => updateLine(idx, { heatPressFee: e.target.value })}>
                <option value="">Select…</option>
                {HEAT_PRESS_FEE_OPTIONS.map((fee) => (
                  <option key={fee} value={fee}>
                    Ksh {fee}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => removeLine(idx)}>
            ✕
          </button>
        </div>
        {outsourced && seeCosts && (
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-divider)', padding: 'var(--space-2) var(--space-3)', margin: 'var(--space-2) 0' }}>
            <div className="card-kicker" style={{ marginBottom: 'var(--space-1)' }}>
              Contracted out{row.supplierName ? ` to ${row.supplierName}` : ''} — price follows the supplier's quote
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 0.8fr auto', gap: 'var(--space-2)', alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Supplier's price per unit (VAT incl., paper + service)</label>
                <input className="input" inputMode="decimal" value={row.supplierCost ?? ''} onChange={(e) => updateLine(idx, { supplierCost: e.target.value })} placeholder="e.g. 40" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Mark-up</label>
                <select className="input" value={row.markupType ?? 'percent'} onChange={(e) => updateLine(idx, { markupType: e.target.value as 'percent' | 'amount' })}>
                  <option value="percent">Percentage (%)</option>
                  <option value="amount">Amount (Ksh per unit)</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>{(row.markupType ?? 'percent') === 'percent' ? 'Mark-up %' : 'Mark-up Ksh'}</label>
                <input className="input" inputMode="decimal" value={row.markupValue ?? ''} onChange={(e) => updateLine(idx, { markupValue: e.target.value })} />
              </div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={suggested <= 0 || suggested === price} onClick={() => updateLine(idx, { unitPrice: suggested })}>
                {suggested > 0 ? `Use ${fmtKsh(suggested)}` : 'Use quote price'}
              </button>
            </div>
            <div className="note" style={{ marginTop: 'var(--space-1)' }}>
              {quote > 0 ? (
                <>
                  Selling at {fmtKsh(price)} a unit on a {fmtKsh(quote)} quote = {realised && realised.percent != null ? `${realised.percent}% (${fmtKsh(realised.amount)})` : '—'} mark-up
                  {price !== suggested && suggested > 0 ? ` — different from the ${fmtKsh(suggested)} the mark-up gives` : ''}. Both prices include VAT.
                </>
              ) : (
                <>Enter the supplier's quote and the price works itself out, or leave it and cost the job later from the order.</>
              )}
            </div>
          </div>
        )}
        {outsourced && !seeCosts && (
          <p className="note" style={{ margin: 'var(--space-1) 0' }}>
            <span className="tag tag-outline">Contracted out</span> — the supplier's cost is recorded separately.
          </p>
        )}
        </div>
        );
      })}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-3)' }}>
        <button type="button" className="btn btn-secondary blueprint" onClick={addLine}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Add line item
        </button>
        <div style={{ textAlign: 'right', fontFamily: 'var(--font-heading)' }}>Subtotal: {fmtKsh(subtotal)}</div>
      </div>
      {lineItems.every(isBlankLine) && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <span className="tag tag-accent">Nothing picked yet</span> — search the service price list and the stock price list in "Item or service" above.
        </p>
      )}
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        Pick a <b>service</b> (Service Price List) or an <b>item</b> (Stock Price List) — type part of the name to find it. Selling and servicing the same
        thing (e.g. printing a cap you're also selling) is two lines: the cap, then the print job. A service line with no matching item line means the client
        brought their own. For an artwork-priced service (DTF Printing, Embroidery), enter one artwork's size — the unit price is worked out for you (area ×
        Ksh/sqm rate); the 📐 calculator gives the area from a length × width.
      </p>
      {missingArtworkArea && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <span className="tag tag-accent">Artwork size not entered</span> — fill in "Artwork size (sqm)" so price
          computes correctly.
        </p>
      )}
      {missingPressingFee && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <span className="tag tag-accent">Heat press fee not selected</span> — pick a fee on the print + press line(s)
          above before capturing the order.
        </p>
      )}
      {calcIdx !== null && (
        <ArtworkSizeDialog
          onApply={({ areaSqm }) => {
            // Set unitPrice explicitly (never leave it to the auto-sync
            // heuristic in updateLine) — the calculator is a fresh
            // computation each time.
            const sv = services.find((s) => s.id === lineItems[calcIdx].serviceId);
            updateLine(calcIdx, { artworkAreaSqm: areaSqm, unitPrice: sv ? computedUnitPrice(sv.price, areaSqm) : 0 });
            setCalcIdx(null);
          }}
          onClose={() => setCalcIdx(null)}
        />
      )}
    </div>
  );
}
