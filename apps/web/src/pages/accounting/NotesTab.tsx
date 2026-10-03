import { useEffect, useState } from 'react';
import { PAYOUT_METHODS, fmtDate, fmtKsh, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { Card, DateRangeBar, Loading, Notice, Tag, money, numStyle, useLoad } from './shared';
import type { Range } from './shared';
import type { AccountRow } from './ChartTab';

type Kind = 'Credit' | 'Debit' | 'SupplierDebit';

interface Note {
  id: number;
  number: string;
  type: Kind;
  date: string;
  party: string;
  reason: string;
  net: number;
  vat: number;
  total: number;
  receivableAmt: number;
  creditAmt: number;
  refundAmt: number;
  refundMethod: string | null;
  restocked: boolean;
  createdByName: string;
  against: string;
  items: { desc: string; qty: number; amount: number }[] | null;
}

interface Sources {
  orders: { id: number; orderNo: string; party: string; date: string; status: string }[];
  expenses: { id: number; ref: string; supplier: string; category: string; amount: number; date: string }[];
}

interface Creditable {
  lines: { lineId: number; desc: string; lineQty: number; unitGross: number; amount: number; material: boolean }[];
  total: number;
  alreadyCredited: number;
  outstanding: number;
}

const TITLES: Record<Kind, { list: string; add: string; blurb: string }> = {
  Credit: { list: 'Credit notes', add: 'New credit note', blurb: 'Takes a sale (and its VAT) back from a customer — returned or faulty goods, a billing error, a goodwill discount. It reduces what the customer owes; whatever they had already paid becomes a credit owed back to them (and can be refunded straight away).' },
  Debit: { list: 'Debit notes', add: 'New debit note', blurb: 'Charges a customer more after the sale — a change request, a rush fee, extra delivery. It adds to what they owe and appears in Accounts Receivable.' },
  SupplierDebit: { list: 'Supplier debit notes', add: 'New supplier debit note', blurb: 'Sent to a supplier when goods are returned or they over-billed. It reduces what you owe them (Accounts Payable) and the expense the goods were booked to.' },
};

export function NotesTab({ range }: { range: Range }) {
  const [kind, setKind] = useState<Kind>('Credit');
  const notes = useLoad<Note[]>(`/accounting/notes?from=${range.from}&to=${range.to}`);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const shown = (notes.data ?? []).filter((n) => n.type === kind);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(['Credit', 'Debit', 'SupplierDebit'] as Kind[]).map((k) => (
          <button key={k} type="button" className={'btn btn-sm ' + (kind === k ? 'btn-primary' : 'btn-secondary')} onClick={() => { setKind(k); setAdding(false); setMsg(''); }}>
            {TITLES[k].list}
          </button>
        ))}
      </div>
      <DateRangeBar range={range} />
      <Notice message={msg} />

      <Card
        title={TITLES[kind].list}
        hint={TITLES[kind].blurb}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : TITLES[kind].add}
          </button>
        }
      >
        {adding && (
          <NoteForm
            kind={kind}
            onDone={(m) => {
              setAdding(false);
              setMsg(m);
              notes.reload();
            }}
          />
        )}
        <Loading loading={notes.loading} error={notes.error} />
        <table className="table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>{kind === 'SupplierDebit' ? 'Supplier' : 'Customer'}</th>
              <th>Against</th>
              <th>Reason</th>
              <th style={numStyle}>Net</th>
              <th style={numStyle}>VAT</th>
              <th style={numStyle}>Total</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="text-muted">
                  None in this period.
                </td>
              </tr>
            )}
            {shown.map((n) => (
              <tr key={n.id}>
                <td>
                  <strong>{n.number}</strong>
                </td>
                <td className="text-muted">{fmtDate(n.date)}</td>
                <td>{n.party}</td>
                <td className="text-muted">{n.against}</td>
                <td>
                  {n.reason}
                  {n.items && <div className="note">{n.items.map((i) => `${i.qty} × ${i.desc}`).join(', ')}</div>}
                </td>
                <td style={numStyle}>{money(n.net)}</td>
                <td style={numStyle}>{money(n.vat)}</td>
                <td style={{ ...numStyle, fontWeight: 700 }}>{money(n.total)}</td>
                <td style={{ fontSize: 12 }}>
                  {n.type === 'Credit' && (
                    <>
                      {n.receivableAmt > 0 && <div>Cut balance by {fmtKsh(n.receivableAmt)}</div>}
                      {n.creditAmt > 0 && <div>{fmtKsh(n.creditAmt)} owed to customer{n.refundAmt > 0 ? ` (refunded ${fmtKsh(n.refundAmt)} by ${n.refundMethod})` : ''}</div>}
                      {n.restocked && <Tag>restocked</Tag>}
                    </>
                  )}
                  {n.type === 'Debit' && <span>Added to what they owe</span>}
                  {n.type === 'SupplierDebit' && <span>Cut what we owe</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function NoteForm({ kind, onDone }: { kind: Kind; onDone: (msg: string) => void }) {
  const sources = useLoad<Sources>('/accounting/notes/sources');
  const accounts = useLoad<AccountRow[]>('/accounting/accounts');
  const [orderId, setOrderId] = useState('');
  const [expenseId, setExpenseId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'items' | 'amount'>('items');
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [amount, setAmount] = useState('');
  const [restock, setRestock] = useState(false);
  const [refundOn, setRefundOn] = useState(false);
  const [refundMethod, setRefundMethod] = useState<string>('Cash');
  const [incomeAccountId, setIncomeAccountId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const info = useLoad<Creditable>(kind === 'Credit' && orderId ? `/accounting/notes/order/${orderId}` : null);
  useEffect(() => setQtys({}), [orderId]);

  const lines = info.data?.lines ?? [];
  const picked = lines.map((l) => ({ l, qty: Math.min(Number(qtys[l.lineId]) || 0, l.lineQty) })).filter((x) => x.qty > 0);
  const itemsTotal = picked.reduce((a, x) => a + x.qty * x.l.unitGross, 0);
  const total = kind === 'Credit' && mode === 'items' ? itemsTotal : Number(amount) || 0;
  const outstanding = info.data?.outstanding ?? 0;
  const receivable = Math.min(total, Math.max(0, outstanding));
  const credit = Math.max(0, total - receivable);
  const hasMaterial = picked.some((x) => x.l.material);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      if (kind === 'Credit') {
        const body: Record<string, unknown> = { orderId: Number(orderId), reason };
        if (mode === 'items') {
          body.items = picked.map((x) => ({ lineId: x.l.lineId, qty: x.qty }));
          body.restock = restock && hasMaterial;
        } else body.amount = Number(amount);
        if (refundOn && credit > 0) body.refund = { method: refundMethod, amount: Math.round(credit * 100) / 100 };
        const n = await api.post<{ number: string }>('/accounting/notes/credit', body);
        onDone(`Credit note ${n.number} issued`);
      } else if (kind === 'Debit') {
        const n = await api.post<{ number: string }>('/accounting/notes/debit', { orderId: Number(orderId), reason, amount: Number(amount), incomeAccountId: incomeAccountId ? Number(incomeAccountId) : null });
        onDone(`Debit note ${n.number} issued`);
      } else {
        const n = await api.post<{ number: string }>('/accounting/notes/supplier', { expenseId: expenseId ? Number(expenseId) : null, supplier: supplier || undefined, reason, amount: Number(amount) });
        onDone(`Supplier debit note ${n.number} issued`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const orderPicker = (
    <div className="field">
      <label>Order</label>
      <select className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
        <option value="">Choose an order…</option>
        {(sources.data?.orders ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.orderNo} — {o.party} ({fmtDate(o.date)})
          </option>
        ))}
      </select>
    </div>
  );

  const ready = reason.trim() && total > 0 && (kind === 'SupplierDebit' ? !!(expenseId || supplier.trim()) : !!orderId);

  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
      <Notice error={err} />
      <div style={{ display: 'grid', gridTemplateColumns: kind === 'SupplierDebit' ? '1.4fr 1fr 2fr' : '1.4fr 2fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        {kind === 'SupplierDebit' ? (
          <>
            <div className="field">
              <label>Against bill / expense</label>
              <select className="input" value={expenseId} onChange={(e) => setExpenseId(e.target.value)}>
                <option value="">None — just a supplier</option>
                {(sources.data?.expenses ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.ref} — {x.supplier || x.category} ({fmtKsh(x.amount)})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Supplier</label>
              <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={expenseId ? 'From the expense' : 'Required'} />
            </div>
          </>
        ) : (
          orderPicker
        )}
        <div className="field">
          <label>Reason</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'Credit' ? 'e.g. Faulty caps returned' : kind === 'Debit' ? 'e.g. Rush delivery' : 'e.g. Wrong ink returned'} />
        </div>
      </div>

      {kind === 'Credit' && orderId && (
        <>
          <div className="seg" style={{ marginBottom: 'var(--space-3)' }}>
            <label className={'seg-opt' + (mode === 'items' ? ' checked' : '')}>
              <input type="radio" checked={mode === 'items'} onChange={() => setMode('items')} />
              Credit specific items
            </label>
            <label className={'seg-opt' + (mode === 'amount' ? ' checked' : '')}>
              <input type="radio" checked={mode === 'amount'} onChange={() => setMode('amount')} />
              Credit an amount
            </label>
          </div>
          {mode === 'items' ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={numStyle}>Sold</th>
                  <th style={numStyle}>Each (incl. VAT)</th>
                  <th style={{ width: 120 }}>Credit qty</th>
                  <th style={numStyle}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const q = Math.min(Number(qtys[l.lineId]) || 0, l.lineQty);
                  return (
                    <tr key={l.lineId}>
                      <td>
                        {l.desc} {l.material && <Tag>material</Tag>}
                      </td>
                      <td style={numStyle}>{l.lineQty}</td>
                      <td style={numStyle}>{money(l.unitGross)}</td>
                      <td>
                        <input className="input" inputMode="decimal" value={qtys[l.lineId] ?? ''} onChange={(e) => setQtys((s) => ({ ...s, [l.lineId]: e.target.value }))} placeholder="0" />
                      </td>
                      <td style={numStyle}>{money(q * l.unitGross)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="field" style={{ maxWidth: 260 }}>
              <label>Amount to credit (Ksh, VAT included)</label>
              <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          {mode === 'items' && hasMaterial && (
            <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
              <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the returned materials back into stock
            </label>
          )}
          {total > 0 && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <p className="note">
                The customer owes {fmtKsh(Math.max(0, outstanding))} on this order. This note of <strong>{fmtKsh(total)}</strong> reduces that balance by <strong>{fmtKsh(receivable)}</strong>
                {credit > 0 ? <> and leaves <strong>{fmtKsh(credit)}</strong> owed back to the customer.</> : '.'}
              </p>
              {credit > 0 && (
                <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                  <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <input type="checkbox" checked={refundOn} onChange={(e) => setRefundOn(e.target.checked)} /> Refund the {fmtKsh(credit)} now by
                  </label>
                  <select className="input" style={{ width: 'auto' }} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} disabled={!refundOn}>
                    {PAYOUT_METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {kind !== 'Credit' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-3)' }}>
          <div className="field">
            <label>Amount (Ksh{kind === 'Debit' ? ', VAT included' : ''})</label>
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {kind === 'Debit' && (
            <div className="field">
              <label>Posts to income account (optional)</label>
              <select className="input" value={incomeAccountId} onChange={(e) => setIncomeAccountId(e.target.value)}>
                <option value="">Other Income</option>
                {(accounts.data ?? []).filter((a) => a.type === 'Income' && a.active && a.code !== '4900').map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <button type="button" className="btn btn-primary" style={{ marginTop: 'var(--space-3)' }} disabled={busy || !ready} onClick={save}>
        Issue {kind === 'Credit' ? 'credit note' : kind === 'Debit' ? 'debit note' : 'supplier debit note'}
      </button>
      <span className="note" style={{ marginLeft: 'var(--space-3)' }}>
        {todayStr()}
      </span>
    </div>
  );
}
