import { buildLineTotal, fmtKsh } from '@glm/shared';
import type { CatalogMaterial, CatalogService, DraftLineItem } from '../api/models';

interface Props {
  lineItems: DraftLineItem[];
  services: CatalogService[];
  materials: CatalogMaterial[];
  onChange: (items: DraftLineItem[]) => void;
}

function defaultLine(services: CatalogService[], materials: CatalogMaterial[]): DraftLineItem {
  const sv = services[0];
  const mt = materials[0];
  return {
    itemType: 'material-service',
    serviceId: sv?.id ?? 0,
    materialId: mt?.id ?? null,
    qty: 1,
    unitPrice: (sv?.price ?? 0) + (mt?.price ?? 0),
    discountPct: 0,
    discountAmt: 0,
  };
}

export function makeDefaultLine(services: CatalogService[], materials: CatalogMaterial[]): DraftLineItem {
  return defaultLine(services, materials);
}

export default function LineItemsEditor({ lineItems, services, materials, onChange }: Props) {
  function updateLine(idx: number, patch: Partial<DraftLineItem>) {
    const next = lineItems.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }

  function handleTypeChange(idx: number, itemType: DraftLineItem['itemType']) {
    const li = lineItems[idx];
    const sv = services.find((s) => s.id === li.serviceId);
    const mt = materials.find((m) => m.id === li.materialId);
    const unitPrice = itemType === 'material-service' ? (sv?.price ?? 0) + (mt?.price ?? 0) : sv?.price ?? 0;
    updateLine(idx, { itemType, unitPrice });
  }

  function handleServiceChange(idx: number, serviceId: number) {
    const li = lineItems[idx];
    const sv = services.find((s) => s.id === serviceId);
    const mt = materials.find((m) => m.id === li.materialId);
    const unitPrice = li.itemType === 'material-service' ? (sv?.price ?? 0) + (mt?.price ?? 0) : sv?.price ?? 0;
    updateLine(idx, { serviceId, unitPrice });
  }

  function handleMaterialChange(idx: number, materialId: number) {
    const li = lineItems[idx];
    const sv = services.find((s) => s.id === li.serviceId);
    const mt = materials.find((m) => m.id === materialId);
    updateLine(idx, { materialId, unitPrice: (sv?.price ?? 0) + (mt?.price ?? 0) });
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
      }),
    0,
  );

  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          opacity: 0.55,
          margin: 'var(--space-5) 0 var(--space-2)',
        }}
      >
        Line items
      </div>

      {lineItems.map((row, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: row.itemType === 'material-service' ? '1.3fr 1fr 1fr 0.7fr 0.9fr 0.7fr 0.7fr auto' : '1.3fr 1fr 0.7fr 0.9fr 0.7fr 0.7fr auto',
            gap: 'var(--space-2)',
            alignItems: 'end',
            padding: 'var(--space-2) 0',
            borderBottom: '1px solid var(--color-divider)',
          }}
        >
          <div className="field" style={{ margin: 0 }}>
            <label>Type</label>
            <select className="input" value={row.itemType} onChange={(e) => handleTypeChange(idx, e.target.value as DraftLineItem['itemType'])}>
              <option value="material-service">Material + Service</option>
              <option value="service-only">Service only (client's item)</option>
              <option value="per-metre">Per-metre service</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Service</label>
            <select className="input" value={row.serviceId} onChange={(e) => handleServiceChange(idx, Number(e.target.value))}>
              {services.map((sv) => (
                <option key={sv.id} value={sv.id}>
                  {sv.name}
                </option>
              ))}
            </select>
          </div>
          {row.itemType === 'material-service' && (
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
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>{row.itemType === 'per-metre' ? 'Metres' : 'Qty'}</label>
            <input className="input" value={row.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} />
          </div>
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
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => removeLine(idx)}>
            ✕
          </button>
        </div>
      ))}

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
    </div>
  );
}
