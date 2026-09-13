import { useState } from 'react';
import { FILM_ROLL_WIDTH_M, HEAT_PRESS_FEE_OPTIONS, buildLineTotal, fmtKsh } from '@glm/shared';
import type { ArtworkSizeBand, CatalogMaterial, CatalogService, DraftLineItem } from '../api/models';
import ArtworkSizeDialog from './ArtworkSizeDialog';

interface Props {
  lineItems: DraftLineItem[];
  services: CatalogService[];
  materials: CatalogMaterial[];
  artworkSizeBands: ArtworkSizeBand[];
  onChange: (items: DraftLineItem[]) => void;
}

// A line is either a material sale (Cap, Polo Shirt, canvas, ...) or a
// service fee (DTF Printing, Embroidery, Large Format Printing, ...) — never
// both. Selling and servicing the same physical item is two separate line
// items (a material line, then a service line), not one combined row — so
// new lines default to a material sale, the natural first step.
function defaultLine(services: CatalogService[], materials: CatalogMaterial[]): DraftLineItem {
  const mt = materials[0];
  return {
    itemType: 'material',
    serviceId: null,
    materialId: mt?.id ?? null,
    qty: 1,
    unitPrice: mt?.price ?? 0,
    discountPct: 0,
    discountAmt: 0,
    filmLengthM: '',
    heatPressFee: '',
    artworkAreaSqm: '',
  };
}

export function makeDefaultLine(services: CatalogService[], materials: CatalogMaterial[]): DraftLineItem {
  return defaultLine(services, materials);
}

// Per-piece price for an artwork-priced service (e.g. DTF Printing,
// Embroidery): a single artwork's area × the service's Ksh/sqm rate.
function computedUnitPrice(rate: number, areaSqm: number): number {
  return Math.round(rate * areaSqm * 100) / 100;
}

// Total film consumed across all pieces, in linear metres off the fixed
// roll width — the same unit FilmRoll/FilmUsage track in everywhere else.
// Only meaningful for a service that also tracksFilm (Embroidery doesn't).
function computedFilmLengthM(areaSqm: number, qty: number): number {
  return Math.round((areaSqm * qty * 100) / FILM_ROLL_WIDTH_M) / 100;
}

function initialUnitPriceFor(sv: CatalogService | undefined): number {
  // An artwork-priced service (DTF Printing, Embroidery) has no artwork
  // area yet on a fresh selection, so its per-piece price starts at 0
  // rather than the raw Ksh/sqm rate — it fills in once an area is entered.
  if (sv?.unit === 'sqm' && sv.usesArtworkPricing) return 0;
  return sv?.price ?? 0;
}

export default function LineItemsEditor({ lineItems, services, materials, artworkSizeBands, onChange }: Props) {
  const [calcIdx, setCalcIdx] = useState<number | null>(null);

  function updateLine(idx: number, patch: Partial<DraftLineItem>) {
    const next = lineItems.slice();
    const current = next[idx];
    const merged: DraftLineItem = { ...current, ...patch };
    const sv = services.find((s) => s.id === merged.serviceId);

    // For a per-metre film-tracked service (DTF Sheet), Film used (m)
    // defaults to match Metres — most jobs consume exactly what's billed.
    // Only auto-sync while the two are still in sync (or film length hasn't
    // been set yet) so an explicit override to Film used (m) always wins.
    if (sv?.tracksFilm && sv.unit === 'metre' && !('filmLengthM' in patch)) {
      const inSync = current.filmLengthM === '' || current.filmLengthM == null || String(current.filmLengthM) === String(current.qty);
      if (inSync) merged.filmLengthM = merged.qty;
    }

    // For an artwork-priced service (DTF Printing, Embroidery), a single
    // artwork's area × the service's Ksh/sqm rate gives the per-piece
    // price — recomputed whenever area changes, but only while still in
    // sync with what was last auto-computed (an explicit override to Unit
    // price always wins). Independent of film tracking: Embroidery prices
    // by artwork size with no film to track at all.
    if (sv?.usesArtworkPricing && sv.unit === 'sqm' && !('unitPrice' in patch)) {
      const area = Number(merged.artworkAreaSqm) || 0;
      const prevArea = Number(current.artworkAreaSqm) || 0;
      const priceInSync = current.unitPrice === '' || current.unitPrice == null || Number(current.unitPrice) === computedUnitPrice(sv.price, prevArea);
      if (priceInSync) merged.unitPrice = area > 0 ? computedUnitPrice(sv.price, area) : '';
    }

    // That same area × quantity gives the total film consumed (converted to
    // linear metres) for a service that also tracksFilm (DTF Printing) —
    // separate from the price calc above since a service can be
    // artwork-priced without tracking film (Embroidery).
    if (sv?.tracksFilm && sv.unit === 'sqm' && !('filmLengthM' in patch)) {
      const area = Number(merged.artworkAreaSqm) || 0;
      const qty = Number(merged.qty) || 0;
      const prevArea = Number(current.artworkAreaSqm) || 0;
      const prevQty = Number(current.qty) || 0;
      const filmInSync = current.filmLengthM === '' || current.filmLengthM == null || Number(current.filmLengthM) === computedFilmLengthM(prevArea, prevQty);
      if (filmInSync) merged.filmLengthM = area > 0 && qty > 0 ? computedFilmLengthM(area, qty) : '';
    }

    next[idx] = merged;
    onChange(next);
  }

  function handleTypeChange(idx: number, itemType: DraftLineItem['itemType']) {
    if (itemType === 'material') {
      const mt = materials.find((m) => m.id === lineItems[idx].materialId) ?? materials[0];
      updateLine(idx, { itemType, serviceId: null, materialId: mt?.id ?? null, unitPrice: mt?.price ?? 0, artworkAreaSqm: '' });
    } else {
      const sv = services.find((s) => s.id === lineItems[idx].serviceId) ?? services[0];
      updateLine(idx, { itemType, materialId: null, serviceId: sv?.id ?? null, unitPrice: initialUnitPriceFor(sv), artworkAreaSqm: '' });
    }
  }

  function handleServiceChange(idx: number, serviceId: number) {
    const sv = services.find((s) => s.id === serviceId);
    updateLine(idx, { serviceId, unitPrice: initialUnitPriceFor(sv), artworkAreaSqm: '', filmLengthM: '' });
  }

  // A size band sets area AND price together as a flat quick-pick, bypassing
  // the area × Ksh/sqm formula — small artworks are dominated by fixed
  // setup/press time, not material, so a pure area rate underprices them.
  // Film used (m) still recomputes off the band's own area, so usage
  // tracking stays exactly as accurate as a custom-sized artwork.
  function handleSizeBand(idx: number, bandId: string) {
    const band = artworkSizeBands.find((b) => String(b.id) === bandId);
    if (band) updateLine(idx, { artworkAreaSqm: band.areaSqm, unitPrice: band.price });
  }

  function handleMaterialChange(idx: number, materialId: number) {
    const mt = materials.find((m) => m.id === materialId);
    updateLine(idx, { materialId, unitPrice: mt?.price ?? 0 });
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

  const missingFilmLength = lineItems.some((li) => {
    const sv = services.find((s) => s.id === li.serviceId);
    return sv?.tracksFilm && !(Number(li.filmLengthM) > 0);
  });

  const missingArtworkArea = lineItems.some((li) => {
    const sv = services.find((s) => s.id === li.serviceId);
    return (sv?.usesArtworkPricing || sv?.tracksFilm) && sv?.unit === 'sqm' && !(Number(li.artworkAreaSqm) > 0);
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
        const tracksFilm = !isMaterial && !!rowService?.tracksFilm;
        const usesArtworkPricing = !isMaterial && !!rowService?.usesArtworkPricing && rowService?.unit === 'sqm';
        const chargesPressingFee = !isMaterial && !!rowService?.chargesPressingFee;
        const bandsForService = artworkSizeBands.filter((b) => b.serviceId === row.serviceId);
        const matchedBand = usesArtworkPricing
          ? bandsForService.find((b) => Number(row.artworkAreaSqm) === b.areaSqm && Number(row.unitPrice) === b.price)
          : undefined;
        const baseCols = '1.3fr 1.3fr 0.7fr 0.9fr 0.7fr 0.7fr';
        const extraCols = (usesArtworkPricing ? ' 0.9fr' : '') + (tracksFilm ? ' 0.8fr' : '') + (chargesPressingFee ? ' 0.9fr' : '');
        const cols = baseCols + extraCols + ' auto';
        return (
        <div
          key={idx}
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
            <label>Type</label>
            <select className="input" value={row.itemType} onChange={(e) => handleTypeChange(idx, e.target.value as DraftLineItem['itemType'])}>
              <option value="material">Material</option>
              <option value="service">Service</option>
              <option value="per-metre">Per-metre service</option>
            </select>
          </div>
          {isMaterial ? (
            <div className="field" style={{ margin: 0 }}>
              <label>Material</label>
              <select className="input" value={row.materialId ?? ''} onChange={(e) => handleMaterialChange(idx, Number(e.target.value))}>
                {materials.map((mt) => (
                  <option key={mt.id} value={mt.id}>
                    {mt.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field" style={{ margin: 0 }}>
              <label>Service</label>
              <select className="input" value={row.serviceId ?? ''} onChange={(e) => handleServiceChange(idx, Number(e.target.value))}>
                {services.map((sv) => (
                  <option key={sv.id} value={sv.id}>
                    {sv.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>{row.itemType === 'per-metre' ? 'Metres' : 'Qty'}</label>
            <input className="input" value={row.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} />
          </div>
          {usesArtworkPricing && (
            <div className="field" style={{ margin: 0 }}>
              <label>Artwork size (sqm)</label>
              {bandsForService.length > 0 && (
                <select className="input" style={{ marginBottom: 4 }} value="" onChange={(e) => handleSizeBand(idx, e.target.value)}>
                  <option value="">Quick size…</option>
                  {bandsForService.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} — Ksh {b.price}
                    </option>
                  ))}
                </select>
              )}
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
              {matchedBand && (
                <span className="tag tag-neutral" style={{ fontSize: 10, marginTop: 2 }}>
                  Matched: {matchedBand.label}
                </span>
              )}
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
          {tracksFilm && (
            <div className="field" style={{ margin: 0 }}>
              <label>Film used (m)</label>
              <input
                className="input"
                value={row.filmLengthM}
                onChange={(e) => updateLine(idx, { filmLengthM: e.target.value })}
                placeholder={row.itemType === 'per-metre' ? String(row.qty) : 'e.g. 2.5'}
                readOnly={rowService?.unit === 'sqm'}
              />
            </div>
          )}
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
      <p className="note" style={{ marginTop: 'var(--space-2)' }}>
        Selling and servicing the same item (e.g. printing a cap you're also selling) is two lines: a Material line
        for the cap, then a Service line for the print job. A Service line with no matching Material line above it
        means the client brought their own item. For an artwork-priced service (DTF Printing, Embroidery), enter one
        artwork's size — unit price is computed for you (area × Ksh/sqm rate); services that also consume film (DTF
        Printing) additionally compute film used from that same area × quantity. Small, common artwork sizes can
        instead use "Quick size", or the 📐 calculator, which auto-matches a predefined band from the length × width
        you enter (set up in Master Data → Artwork Size Bands, per service).
      </p>
      {missingArtworkArea && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <span className="tag tag-accent">Artwork size not entered</span> — fill in "Artwork size (sqm)" so price
          {lineItems.some((li) => services.find((s) => s.id === li.serviceId)?.tracksFilm) ? ' and film usage compute' : ' computes'} correctly.
        </p>
      )}
      {missingFilmLength && !missingArtworkArea && (
        <p className="note" style={{ marginTop: 'var(--space-2)' }}>
          <span className="tag tag-accent">Film usage not entered</span> — fill in "Film used (m)" on the DTF line(s)
          above so it logs against the active film roll.
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
          artworkSizeBands={artworkSizeBands.filter((b) => b.serviceId === lineItems[calcIdx].serviceId)}
          onApply={({ areaSqm, band }) => {
            // Always set unitPrice explicitly here (never leave it to the
            // auto-sync heuristic in updateLine) — the calculator is a
            // fresh computation each time, so a previous band's flat price
            // must never linger once the artwork no longer matches it.
            if (band) {
              updateLine(calcIdx, { artworkAreaSqm: band.areaSqm, unitPrice: band.price });
            } else {
              const sv = services.find((s) => s.id === lineItems[calcIdx].serviceId);
              updateLine(calcIdx, { artworkAreaSqm: areaSqm, unitPrice: sv ? computedUnitPrice(sv.price, areaSqm) : 0 });
            }
            setCalcIdx(null);
          }}
          onClose={() => setCalcIdx(null)}
        />
      )}
    </div>
  );
}
