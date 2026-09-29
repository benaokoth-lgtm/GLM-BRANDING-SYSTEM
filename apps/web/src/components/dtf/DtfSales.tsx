import { useState } from 'react';
import { fmtDate, fmtKsh, fmtNum, saleCalc, saleTotals, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, Corners, Field, Spec, num, right } from './shared';
import type { DtfTabProps } from './shared';
import DtfOrderDialog from './DtfOrderDialog';

export default function DtfSales({ data, reload, setError }: DtfTabProps) {
  const { user } = useAuth();
  const { settings } = data;
  const isAdmin = user?.role === 'Admin';
  const open = data.rolls.filter((r) => r.status === 'open' && r.installedOn);
  const [f, setF] = useState({ roll: '', client: '', metres: '', price: '' });
  const [busy, setBusy] = useState(false);
  const [showOrderDialog, setShowOrderDialog] = useState(false);

  const rollId = f.roll && open.some((r) => r.id === f.roll) ? f.roll : (open[0]?.id ?? '');
  const roll = open.find((r) => r.id === rollId);
  const metres = num(f.metres);
  const c = saleCalc(settings, metres, f.price.trim() === '' ? null : num(f.price), 0);
  const used =
    data.sales.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.metres, 0) +
    data.jobs.filter((x) => x.rollId === rollId).reduce((a, x) => a + x.runningMetres, 0);
  const rollLen = roll?.rollLengthM || settings.rollLengthM;
  const overRoll = !!roll && used + metres > rollLen;
  const canSave = !busy && metres > 0 && !!rollId && c.valid;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 300px', maxWidth: 400 }} className="no-print">
        <Card title="Record film sale">
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <Field label="Roll">
              <select className="input" value={rollId} onChange={(e) => setF({ ...f, roll: e.target.value })}>
                {open.length === 0 && <option value="">No open rolls</option>}
                {open.map((r) => (
                  <option key={r.id} value={r.id}>{r.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Client">
              <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <Field label="Metres">
                <input className="input" inputMode="decimal" value={f.metres} onChange={(e) => setF({ ...f, metres: e.target.value })} />
              </Field>
              <Field label="Price / m">
                <input className="input" inputMode="decimal" placeholder={String(settings.stdPricePerM)} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
              </Field>
            </div>
            {!c.valid && (
              <div className="note" style={{ borderLeft: '2px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
                Blocked — price must be {settings.minPricePerM}–{settings.stdPricePerM} Ksh/m.
              </div>
            )}
            {overRoll && (
              <div className="note">
                This would use more than the roll's {fmtNum(rollLen)} m ({fmtNum(used, 1)} m already used).
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              <Spec label="Price used" value={fmtKsh(c.price)} />
              <Spec label="Discount / m" value={fmtKsh(c.discountPerM)} />
              <Spec label="Sale total" value={fmtKsh(c.total)} />
            </div>
            <button type="button" className="btn btn-primary blueprint" disabled={!canSave} onClick={() => setShowOrderDialog(true)}>
              <Corners />
              Record sale
            </button>
          </div>
        </Card>
      </div>

      {showOrderDialog && (
        <DtfOrderDialog
          mode="sale"
          postUrl="/dtf/sales"
          basePayload={{ rollId, soldOn: todayStr(), client: f.client, metres, pricePerM: f.price.trim() === '' ? null : num(f.price) }}
          qty={metres}
          unitPrice={c.price}
          client={f.client}
          onClose={() => setShowOrderDialog(false)}
          onDone={() => {
            setShowOrderDialog(false);
            setF({ roll: rollId, client: '', metres: '', price: '' });
            reload();
          }}
        />
      )}

      <div style={{ flex: '3 1 520px', minWidth: 0 }}>
        <Card title="Film sales">
          {data.sales.length === 0 ? (
            <p className="note">No sales yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Date</th><th>Roll</th><th>Client</th>
                    <th style={right}>Metres</th><th style={right}>Price/m</th><th style={right}>Disc/m</th>
                    <th style={right}>Total</th><th style={right}>Paid</th><th style={right}>Balance</th>
                    {data.canManage && <th className="no-print"></th>}
                  </tr>
                </thead>
                <tbody>
                  {data.sales.map((x) => {
                    const t = saleTotals(x);
                    return (
                      <tr key={x.id}>
                        <td className="text-muted">{fmtDate(x.soldOn)}</td>
                        <td>{x.rollId}</td>
                        <td>{x.client || '—'}</td>
                        <td style={right}>{fmtNum(x.metres, 2)}</td>
                        <td style={right}>{fmtNum(x.pricePerM)}</td>
                        <td style={right}>{fmtNum(t.discountPerM)}</td>
                        <td style={{ ...right, fontWeight: 700 }}>{fmtNum(t.total)}</td>
                        <td style={right}>{fmtNum(x.amountPaid)}</td>
                        <td style={right}>{fmtNum(t.balance)}</td>
                        {data.canManage && (
                          <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                            {t.balance > 0 && (
                              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/dtf/sales/${x.id}/paid`, { amountPaid: t.total }))}>
                                Mark paid
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => window.confirm(`Delete this sale (${x.rollId}, ${fmtNum(x.metres, 2)} m)?`) && act(() => api.del(`/dtf/sales/${x.id}`))}
                              >
                                Delete
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
