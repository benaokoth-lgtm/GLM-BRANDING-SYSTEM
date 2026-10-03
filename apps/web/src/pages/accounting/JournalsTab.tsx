import { useState } from 'react';
import { fmtDate, todayStr } from '@glm/shared';
import { api } from '../../api/client';
import { useAuth } from '../../state/AuthContext';
import { Card, Loading, Notice, money, numStyle, useLoad } from './shared';
import type { AccountRow } from './ChartTab';

// What has no operational home lives here: opening balances, owner capital/drawings, bank deposits and tax payments.
// Sales, payments, expenses, wages, petty cash, depreciation and notes post themselves — never journal those.

interface Entry {
  id: number;
  ref: string;
  date: string;
  memo: string;
  source: string;
  createdByName: string;
  lines: { id: number; account: string; debit: number; credit: number; memo: string }[];
}

interface Line {
  accountId: string;
  debit: string;
  credit: string;
}

type Template = { id: string; label: string; source: string; hint: string; lines: { code: string; side: 'debit' | 'credit' }[] };
const TEMPLATES: Template[] = [
  { id: 'capital', label: 'Owner puts money in', source: 'Capital', hint: 'Money paid into the business by the owner: debit where it went (Bank, Cash…), credit Owner’s Capital.', lines: [{ code: '1050', side: 'debit' }, { code: '3010', side: 'credit' }] },
  { id: 'drawings', label: 'Owner takes money out', source: 'Drawings', hint: 'Money the owner took: debit Owner’s Drawings, credit where it came from (Bank, Cash…).', lines: [{ code: '3020', side: 'debit' }, { code: '1050', side: 'credit' }] },
  { id: 'deposit', label: 'Bank deposit (cash → bank)', source: 'BankDeposit', hint: 'Takings banked: debit Bank Account, credit Cash on Hand (or M-Pesa).', lines: [{ code: '1050', side: 'debit' }, { code: '1020', side: 'credit' }] },
  { id: 'tax', label: 'Pay VAT / PAYE / NSSF…', source: 'TaxPayment', hint: 'Remitting what was collected or withheld: debit the payable account, credit Bank.', lines: [{ code: '2100', side: 'debit' }, { code: '1050', side: 'credit' }] },
  { id: 'opening', label: 'Opening balance', source: 'Opening', hint: 'Starting balances when you begin using the books (e.g. bank and cash on hand against Retained Earnings). Not counted as cash flow.', lines: [{ code: '1050', side: 'debit' }, { code: '3030', side: 'credit' }] },
  { id: 'manual', label: 'Other journal', source: 'Manual', hint: 'Any other balanced entry, e.g. a loan received. Receivables, payables and petty cash can’t be journalled.', lines: [{ code: '', side: 'debit' }, { code: '', side: 'credit' }] },
];

export function JournalsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const accounts = useLoad<AccountRow[]>('/accounting/accounts');
  const entries = useLoad<Entry[]>('/accounting/journals');
  const [tpl, setTpl] = useState<Template>(TEMPLATES[0]!);
  const [date, setDate] = useState(todayStr());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const list = (accounts.data ?? []).filter((a) => a.active && !['1010', '1100', '2010', '2310'].includes(a.code));
  const idOfCode = (code: string) => String((accounts.data ?? []).find((a) => a.code === code)?.id ?? '');

  function pick(t: Template) {
    setTpl(t);
    setLines(t.lines.map((l) => ({ accountId: l.code ? idOfCode(l.code) : '', debit: '', credit: '' })));
  }
  const shown: Line[] = lines.length ? lines : tpl.lines.map((l) => ({ accountId: l.code ? idOfCode(l.code) : '', debit: '', credit: '' }));
  const setLine = (i: number, patch: Partial<Line>) => setLines(shown.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const debit = shown.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const credit = shown.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(debit - credit) < 0.005 && debit > 0;

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.post('/accounting/journals', {
        date,
        memo: memo || tpl.label,
        source: tpl.source,
        lines: shown.filter((l) => l.accountId && (Number(l.debit) || Number(l.credit))).map((l) => ({ accountId: Number(l.accountId), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      });
      setMsg('Journal posted');
      setMemo('');
      setLines([]);
      entries.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm('Reverse (delete) this journal? This changes the books.')) return;
    setBusy(true);
    try {
      await api.del(`/accounting/journals/${id}`);
      entries.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Notice error={err} message={msg} />
      <Card title="New journal" hint={tpl.hint}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={'btn btn-sm ' + (tpl.id === t.id ? 'btn-primary' : 'btn-secondary')} onClick={() => pick(t)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <div className="field">
            <label>Date</label>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Description</label>
            <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={tpl.label} />
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th style={numStyle}>Debit</th>
              <th style={numStyle}>Credit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="input" value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })}>
                    <option value="">Choose…</option>
                    {list.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="input" style={{ textAlign: 'right' }} value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} />
                </td>
                <td>
                  <input className="input" style={{ textAlign: 'right' }} value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} />
                </td>
                <td>{shown.length > 2 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines(shown.filter((_, n) => n !== i))}>✕</button>}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}>
              <td>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines([...shown, { accountId: '', debit: '', credit: '' }])}>
                  + Add line
                </button>
              </td>
              <td style={numStyle}>{money(debit)}</td>
              <td style={numStyle}>{money(credit)}</td>
              <td>{balanced ? '✓' : ''}</td>
            </tr>
          </tbody>
        </table>
        <button type="button" className="btn btn-primary" style={{ marginTop: 'var(--space-3)' }} disabled={busy || !balanced} onClick={save}>
          Post journal
        </button>
      </Card>

      <Card title="Journals posted" hint="Only entries typed here appear — everything else posts itself from its own screen.">
        <Loading loading={entries.loading} error={entries.error} />
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ref</th>
              <th>Type</th>
              <th>Detail</th>
              <th style={numStyle}>Ksh</th>
              <th>By</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(entries.data ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted">
                  No journals yet.
                </td>
              </tr>
            )}
            {(entries.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="text-muted">{fmtDate(e.date)}</td>
                <td className="text-muted">{e.ref}</td>
                <td>{e.source}</td>
                <td>
                  {e.memo}
                  <div className="note">{e.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account}`).join('  ·  ')}</div>
                </td>
                <td style={numStyle}>{money(e.lines.reduce((a, l) => a + l.debit, 0))}</td>
                <td className="text-muted">{e.createdByName}</td>
                <td>{isAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(e.id)} disabled={busy}>Reverse</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
