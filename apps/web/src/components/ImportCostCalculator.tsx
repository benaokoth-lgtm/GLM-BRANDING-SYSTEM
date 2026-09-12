import { useState } from 'react';
import { todayStr } from '@glm/shared';
import { api } from '../api/client';

interface KraLine {
  id: number;
  desc: string;
  unitPriceUSD: string;
  qty: string;
  dutyPct: string;
  excisePct: string;
}

interface ConsLine {
  id: number;
  desc: string;
  unitPriceUSD: string;
  qty: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

interface PushLine {
  description: string;
  qty: number;
  unitCost: number;
  totalCost: number;
}

let nextId = 1;

const num = (v: string) => Number(v) || 0;

// KES values on this calculator show 2 decimal places (duty/VAT/RDL/IDF
// compound off fractional CIF, so cent-level precision matters here more
// than on a POS receipt) — deliberately not fmtKsh, which rounds to whole
// Ksh for every other screen in the app.
function fmt(n: number): string {
  return n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const KRA_NEW_LINE = (): KraLine => ({ id: nextId++, desc: 'New item', unitPriceUSD: '0', qty: '1', dutyPct: '25', excisePct: '0' });
const CONS_NEW_LINE = (): ConsLine => ({ id: nextId++, desc: 'New item', unitPriceUSD: '0', qty: '1', lengthCm: '0', widthCm: '0', heightCm: '0' });

interface Props {
  onImported: () => void;
}

// China Import Cost Calculator — two independent, self-contained models for
// the same shipment (KRA's full duty stack vs. a consolidator's flat
// weight/CBM charge), per the design handoff. A single-session tool with no
// persistence of its own; "Send to Stock" below is the one addition beyond
// the handoff spec, turning the computed per-line landed cost into Held
// purchases in the existing Stock pipeline.
export default function ImportCostCalculator({ onImported }: Props) {
  const [mode, setMode] = useState<'kra' | 'consolidator'>('kra');

  const [kraRate, setKraRate] = useState('130');
  const [kraFreight, setKraFreight] = useState('500');
  const [kraInsurance, setKraInsurance] = useState('100');
  const [kraLines, setKraLines] = useState<KraLine[]>([
    { id: nextId++, desc: 'Phone accessories', unitPriceUSD: '2.5', qty: '500', dutyPct: '25', excisePct: '0' },
    { id: nextId++, desc: 'LED strip lights', unitPriceUSD: '4', qty: '200', dutyPct: '25', excisePct: '0' },
  ]);

  const [consRate, setConsRate] = useState('130');
  const [consBasis, setConsBasis] = useState<'weight' | 'cbm'>('weight');
  const [consRatePerKg, setConsRatePerKg] = useState('85');
  const [consRatePerCbm, setConsRatePerCbm] = useState('85');
  const [consTotalWeightKg, setConsTotalWeightKg] = useState('450');
  const [consInlandFreightKES, setConsInlandFreightKES] = useState('8000');
  const [consLines, setConsLines] = useState<ConsLine[]>([
    { id: nextId++, desc: 'Phone accessories', unitPriceUSD: '2.5', qty: '500', lengthCm: '40', widthCm: '30', heightCm: '25' },
    { id: nextId++, desc: 'LED strip lights', unitPriceUSD: '4', qty: '200', lengthCm: '50', widthCm: '35', heightCm: '20' },
  ]);

  const [reference, setReference] = useState('');
  const [pushDate, setPushDate] = useState(todayStr());
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushedCount, setPushedCount] = useState<number | null>(null);

  function updateKraLine(id: number, patch: Partial<KraLine>) {
    setKraLines((lines) => lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    setPushedCount(null);
  }
  function updateConsLine(id: number, patch: Partial<ConsLine>) {
    setConsLines((lines) => lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    setPushedCount(null);
  }

  // ---- KRA model ----
  const kraRawLines = kraLines.map((l) => ({ ...l, fobUSD: num(l.unitPriceUSD) * num(l.qty) }));
  const totalFobUSD = kraRawLines.reduce((a, l) => a + l.fobUSD, 0);
  const freightInsuranceUSD = num(kraFreight) + num(kraInsurance);
  const kraComputed = kraRawLines.map((l) => {
    const share = totalFobUSD > 0 ? l.fobUSD / totalFobUSD : 0;
    const cifUSD = l.fobUSD + share * freightInsuranceUSD;
    const cifKES = cifUSD * num(kraRate);
    const duty = cifKES * (num(l.dutyPct) / 100);
    const excise = (cifKES + duty) * (num(l.excisePct) / 100);
    const vat = (cifKES + duty + excise) * 0.16;
    const rdl = cifKES * 0.02;
    return { ...l, fobKES: l.fobUSD * num(kraRate), cifKES, duty, excise, vat, rdl };
  });
  const totalCifKES = kraComputed.reduce((a, l) => a + l.cifKES, 0);
  const idfTotal = Math.max(totalCifKES * 0.0225, 5000);
  const kraResultRows = kraComputed.map((l) => {
    const idfShare = totalCifKES > 0 ? (l.cifKES / totalCifKES) * idfTotal : 0;
    const landed = l.cifKES + l.duty + l.excise + l.vat + l.rdl + idfShare;
    const qty = num(l.qty);
    return { id: l.id, desc: l.desc, qty, fob: l.fobKES, cif: l.cifKES, duty: l.duty, excise: l.excise, vat: l.vat, rdl: l.rdl, idf: idfShare, landed, perUnit: qty > 0 ? landed / qty : 0 };
  });
  const kraTotals = {
    fob: kraComputed.reduce((a, l) => a + l.fobKES, 0),
    cif: totalCifKES,
    duty: kraComputed.reduce((a, l) => a + l.duty, 0),
    excise: kraComputed.reduce((a, l) => a + l.excise, 0),
    vat: kraComputed.reduce((a, l) => a + l.vat, 0),
    rdl: kraComputed.reduce((a, l) => a + l.rdl, 0),
    idf: idfTotal,
    landed: totalCifKES + kraComputed.reduce((a, l) => a + l.duty + l.excise + l.vat + l.rdl, 0) + idfTotal,
  };

  // ---- Consolidator model ----
  const consRawLines = consLines.map((l) => {
    const totalUSD = num(l.unitPriceUSD) * num(l.qty);
    const cbm = (num(l.lengthCm) / 100) * (num(l.widthCm) / 100) * (num(l.heightCm) / 100) * num(l.qty);
    return { ...l, totalUSD, totalKES: totalUSD * num(consRate), cbm };
  });
  const totalGoodsKES = consRawLines.reduce((a, l) => a + l.totalKES, 0);
  const totalCbm = consRawLines.reduce((a, l) => a + l.cbm, 0);
  const basisAmount = consBasis === 'weight' ? num(consTotalWeightKg) : totalCbm;
  const basisRate = consBasis === 'weight' ? num(consRatePerKg) : num(consRatePerCbm);
  const consolidatorTaxKES = basisAmount * basisRate;
  const inlandFreightKES = num(consInlandFreightKES);
  const consResultRows = consRawLines.map((l) => {
    const share = totalGoodsKES > 0 ? l.totalKES / totalGoodsKES : 0;
    const tax = share * consolidatorTaxKES;
    const freight = share * inlandFreightKES;
    const landed = l.totalKES + tax + freight;
    const qty = num(l.qty);
    return { id: l.id, desc: l.desc, qty, goods: l.totalKES, tax, freight, landed, perUnit: qty > 0 ? landed / qty : 0 };
  });
  const consTotals = {
    goods: totalGoodsKES,
    basisAmount,
    tax: consolidatorTaxKES,
    freight: inlandFreightKES,
    landed: totalGoodsKES + consolidatorTaxKES + inlandFreightKES,
  };

  const resultRows = mode === 'kra' ? kraResultRows : consResultRows;

  async function pushToStock() {
    setPushError(null);
    setPushedCount(null);
    const lines: PushLine[] = resultRows
      .filter((r) => r.desc.trim() && r.qty > 0)
      .map((r) => ({ description: r.desc.trim(), qty: r.qty, unitCost: r.perUnit, totalCost: r.landed }));
    if (lines.length === 0) return setPushError('No valid line items to send — every line needs a description, quantity and landed cost.');

    setPushing(true);
    try {
      const created = await api.post<unknown[]>('/stock/imports', { model: mode, reference: reference.trim() || undefined, date: pushDate, lines });
      setPushedCount(created.length);
      onImported();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to send to stock');
    } finally {
      setPushing(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="field" style={{ margin: 0, maxWidth: 460 }}>
        <label>Costing model</label>
        <div className="seg" role="radiogroup" aria-label="Model">
          <label className={'seg-opt' + (mode === 'kra' ? ' checked' : '')}>
            <input type="radio" name="import-mode" checked={mode === 'kra'} onChange={() => setMode('kra')} />
            KRA Full Tax
          </label>
          <label className={'seg-opt' + (mode === 'consolidator' ? ' checked' : '')}>
            <input type="radio" name="import-mode" checked={mode === 'consolidator'} onChange={() => setMode('consolidator')} />
            Consolidator (Weight/CBM)
          </label>
        </div>
      </div>

      {mode === 'kra' ? (
        <p className="note" style={{ maxWidth: '70ch' }}>
          Full KRA import duty model: CIF is built from goods value plus shipment freight and insurance, then Import
          Duty, Excise, VAT, IDF Fee and the Railway Development Levy are applied per KRA's stacked formula.
        </p>
      ) : (
        <p className="note" style={{ maxWidth: '70ch' }}>
          Consolidator model: the clearing agent charges a per-shipment "tax" based on chargeable weight or volume
          (CBM) instead of KRA's duty stack, then you pay inland freight from the port/warehouse to your shop.
        </p>
      )}

      <div className="card blueprint elev-sm" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">Shipment</div>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          {mode === 'kra' ? 'Exchange rate & shipment costs' : 'Exchange rate & charge basis'}
        </div>
        {mode === 'kra' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>USD → KES rate</label>
              <input className="input" value={kraRate} onChange={(e) => { setKraRate(e.target.value); setPushedCount(null); }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Freight (USD)</label>
              <input className="input" value={kraFreight} onChange={(e) => { setKraFreight(e.target.value); setPushedCount(null); }} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Insurance (USD)</label>
              <input className="input" value={kraInsurance} onChange={(e) => { setKraInsurance(e.target.value); setPushedCount(null); }} />
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
              <div className="field" style={{ margin: 0 }}>
                <label>USD → KES rate</label>
                <input className="input" value={consRate} onChange={(e) => { setConsRate(e.target.value); setPushedCount(null); }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Inland freight to shop (KES)</label>
                <input className="input" value={consInlandFreightKES} onChange={(e) => { setConsInlandFreightKES(e.target.value); setPushedCount(null); }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Charge basis</label>
                <div className="seg" role="radiogroup" aria-label="Charge basis">
                  <label className={'seg-opt' + (consBasis === 'weight' ? ' checked' : '')}>
                    <input type="radio" name="cons-basis" checked={consBasis === 'weight'} onChange={() => { setConsBasis('weight'); setPushedCount(null); }} />
                    Per kg
                  </label>
                  <label className={'seg-opt' + (consBasis === 'cbm' ? ' checked' : '')}>
                    <input type="radio" name="cons-basis" checked={consBasis === 'cbm'} onChange={() => { setConsBasis('cbm'); setPushedCount(null); }} />
                    Per CBM
                  </label>
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
              {consBasis === 'weight' ? (
                <>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Total shipment weight (kg)</label>
                    <input className="input" value={consTotalWeightKg} onChange={(e) => { setConsTotalWeightKg(e.target.value); setPushedCount(null); }} />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Rate (KES per kg)</label>
                    <input className="input" value={consRatePerKg} onChange={(e) => { setConsRatePerKg(e.target.value); setPushedCount(null); }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Total volume (CBM, from lines below)</label>
                    <input className="input" value={`${totalCbm.toLocaleString('en-KE', { maximumFractionDigits: 3 })} CBM`} readOnly />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Rate (KES per CBM)</label>
                    <input className="input" value={consRatePerCbm} onChange={(e) => { setConsRatePerCbm(e.target.value); setPushedCount(null); }} />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card blueprint elev-sm" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">Goods</div>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Line items
        </div>
        <div style={{ overflowX: 'auto' }}>
          {mode === 'kra' ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Unit price (USD)</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Duty %</th>
                  <th style={{ textAlign: 'right' }}>Excise %</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {kraLines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input className="input" value={l.desc} onChange={(e) => updateKraLine(l.id, { desc: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.unitPriceUSD} onChange={(e) => updateKraLine(l.id, { unitPriceUSD: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.qty} onChange={(e) => updateKraLine(l.id, { qty: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.dutyPct} onChange={(e) => updateKraLine(l.id, { dutyPct: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.excisePct} onChange={(e) => updateKraLine(l.id, { excisePct: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => { setKraLines((ls) => ls.filter((x) => x.id !== l.id)); setPushedCount(null); }}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Unit price (USD)</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Total (USD)</th>
                  <th style={{ textAlign: 'right' }}>Total (KES)</th>
                  {consBasis === 'cbm' && (
                    <>
                      <th style={{ textAlign: 'right' }}>L (cm)</th>
                      <th style={{ textAlign: 'right' }}>W (cm)</th>
                      <th style={{ textAlign: 'right' }}>H (cm)</th>
                      <th style={{ textAlign: 'right' }}>CBM</th>
                    </>
                  )}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {consRawLines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input className="input" value={l.desc} onChange={(e) => updateConsLine(l.id, { desc: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.unitPriceUSD} onChange={(e) => updateConsLine(l.id, { unitPriceUSD: e.target.value })} />
                    </td>
                    <td>
                      <input className="input" style={{ textAlign: 'right' }} value={l.qty} onChange={(e) => updateConsLine(l.id, { qty: e.target.value })} />
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.totalUSD)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.totalKES)}</td>
                    {consBasis === 'cbm' && (
                      <>
                        <td>
                          <input className="input" style={{ textAlign: 'right' }} value={l.lengthCm} onChange={(e) => updateConsLine(l.id, { lengthCm: e.target.value })} />
                        </td>
                        <td>
                          <input className="input" style={{ textAlign: 'right' }} value={l.widthCm} onChange={(e) => updateConsLine(l.id, { widthCm: e.target.value })} />
                        </td>
                        <td>
                          <input className="input" style={{ textAlign: 'right' }} value={l.heightCm} onChange={(e) => updateConsLine(l.id, { heightCm: e.target.value })} />
                        </td>
                        <td style={{ textAlign: 'right' }}>{l.cbm.toLocaleString('en-KE', { maximumFractionDigits: 3 })}</td>
                      </>
                    )}
                    <td>
                      <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => { setConsLines((ls) => ls.filter((x) => x.id !== l.id)); setPushedCount(null); }}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary blueprint"
          style={{ marginTop: 'var(--space-4)' }}
          onClick={() => {
            if (mode === 'kra') setKraLines((ls) => [...ls, KRA_NEW_LINE()]);
            else setConsLines((ls) => [...ls, CONS_NEW_LINE()]);
            setPushedCount(null);
          }}
        >
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          Add line item
        </button>
      </div>

      <div className="card blueprint elev-sm" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">Breakdown</div>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Landed cost per item
        </div>
        <div style={{ overflowX: 'auto' }}>
          {mode === 'kra' ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>FOB (KES)</th>
                  <th style={{ textAlign: 'right' }}>CIF (KES)</th>
                  <th style={{ textAlign: 'right' }}>Duty</th>
                  <th style={{ textAlign: 'right' }}>Excise</th>
                  <th style={{ textAlign: 'right' }}>VAT</th>
                  <th style={{ textAlign: 'right' }}>RDL</th>
                  <th style={{ textAlign: 'right' }}>IDF</th>
                  <th style={{ textAlign: 'right' }}>Landed (KES)</th>
                  <th style={{ textAlign: 'right' }}>Per unit (KES)</th>
                </tr>
              </thead>
              <tbody>
                {kraResultRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.desc}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.fob)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.cif)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.duty)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.excise)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.vat)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.rdl)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.idf)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.landed)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.perUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Goods (KES)</th>
                  <th style={{ textAlign: 'right' }}>Consolidator tax (KES)</th>
                  <th style={{ textAlign: 'right' }}>Inland freight (KES)</th>
                  <th style={{ textAlign: 'right' }}>Landed (KES)</th>
                  <th style={{ textAlign: 'right' }}>Per unit (KES)</th>
                </tr>
              </thead>
              <tbody>
                {consResultRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.desc}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.goods)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.tax)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.freight)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.landed)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.perUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {mode === 'consolidator' && (
          <p className="note" style={{ marginTop: 'var(--space-3)' }}>
            Consolidator tax and inland freight are allocated to each line by its share of total goods value.
          </p>
        )}
      </div>

      <div className="card blueprint elev-md" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-kicker">Totals</div>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          Shipment summary
        </div>
        {mode === 'kra' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
            <div>
              <div className="card-kicker">Total FOB</div>
              <div className="card-title">{fmt(kraTotals.fob)}</div>
            </div>
            <div>
              <div className="card-kicker">Total CIF</div>
              <div className="card-title">{fmt(kraTotals.cif)}</div>
            </div>
            <div>
              <div className="card-kicker">Import Duty</div>
              <div className="card-title">{fmt(kraTotals.duty)}</div>
            </div>
            <div>
              <div className="card-kicker">Excise Duty</div>
              <div className="card-title">{fmt(kraTotals.excise)}</div>
            </div>
            <div>
              <div className="card-kicker">VAT (16%)</div>
              <div className="card-title">{fmt(kraTotals.vat)}</div>
            </div>
            <div>
              <div className="card-kicker">Railway Levy (2%)</div>
              <div className="card-title">{fmt(kraTotals.rdl)}</div>
            </div>
            <div>
              <div className="card-kicker">IDF Fee (2.25%, min 5,000)</div>
              <div className="card-title">{fmt(kraTotals.idf)}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
            <div>
              <div className="card-kicker">Total goods value</div>
              <div className="card-title">{fmt(consTotals.goods)}</div>
            </div>
            <div>
              <div className="card-kicker">{consBasis === 'weight' ? 'Total weight' : 'Total volume'}</div>
              <div className="card-title">
                {consBasis === 'weight'
                  ? `${consTotals.basisAmount.toLocaleString('en-KE', { maximumFractionDigits: 1 })} kg`
                  : `${consTotals.basisAmount.toLocaleString('en-KE', { maximumFractionDigits: 3 })} CBM`}
              </div>
            </div>
            <div>
              <div className="card-kicker">Consolidator tax</div>
              <div className="card-title">{fmt(consTotals.tax)}</div>
            </div>
            <div>
              <div className="card-kicker">Inland freight</div>
              <div className="card-title">{fmt(consTotals.freight)}</div>
            </div>
          </div>
        )}
        <div
          style={{
            marginTop: 'var(--space-5)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-divider)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <span className="card-kicker">Grand total landed cost</span>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 32 }}>KES {fmt(mode === 'kra' ? kraTotals.landed : consTotals.landed)}</span>
        </div>
      </div>

      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
          Send to Stock
        </div>
        <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
          Sends the breakdown above to Stock as one Held purchase per line, at its computed per-unit landed cost — a
          different finance manager/general manager/admin still has to accept each one (under Stock → Purchases)
          before it adds to stock on hand. A line whose description matches an existing material re-stocks it;
          otherwise a new material is created.
        </p>
        {pushError && (
          <p className="note" style={{ color: '#a33' }}>
            {pushError}
          </p>
        )}
        {pushedCount != null && (
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="tag tag-accent">{pushedCount} item(s) sent to Stock as Held purchases</span> — go to
            Stock → Purchases to reconcile and accept them.
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Shipment reference / invoice # (optional)</label>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. BL-88213" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Date</label>
            <input className="input" type="date" value={pushDate} onChange={(e) => setPushDate(e.target.value)} />
          </div>
          <button type="button" className="btn btn-primary blueprint" onClick={pushToStock} disabled={pushing}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Send items to Stock
          </button>
        </div>
      </div>
    </div>
  );
}
