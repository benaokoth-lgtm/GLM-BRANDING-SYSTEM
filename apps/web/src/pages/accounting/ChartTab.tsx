import { useState } from 'react';
import { ACCOUNT_TYPES } from '@glm/shared';
import { api } from '../../api/client';
import { AsOfBar, Card, Loading, Notice, Tag, money, numStyle, useLoad, ymd } from './shared';

export interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: string;
  subtype: string;
  description: string;
  system: boolean;
  active: boolean;
  balance: number;
}

interface Links {
  expenseHeads: { id: number; name: string; accountId: number | null; account: string | null }[];
  services: { id: number; name: string; accountId: number | null; account: string | null }[];
  materials: { id: number; name: string; accountId: number | null; account: string | null }[];
}

export function ChartTab() {
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const accounts = useLoad<AccountRow[]>(`/accounting/accounts?asOf=${asOf}`);
  const links = useLoad<Links>('/accounting/links');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', type: 'Expense', description: '' });
  const [newHead, setNewHead] = useState('');

  async function run(fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      accounts.reload();
      links.reload();
      after?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const list = accounts.data ?? [];
  const incomeAccounts = list.filter((a) => a.type === 'Income' && a.active);
  const expenseAccounts = list.filter((a) => a.type === 'Expense' && a.active);

  const LinkRow = ({ label, current, options, onPick, allowDefault }: { label: string; current: number | null; options: AccountRow[]; onPick: (id: number | null) => void; allowDefault?: boolean }) => (
    <tr>
      <td>{label}</td>
      <td>
        <select className="input" value={current ?? ''} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)} disabled={busy}>
          {allowDefault && <option value="">Default (Merchandise & Materials Sales)</option>}
          {!allowDefault && current == null && <option value="">Choose…</option>}
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AsOfBar value={asOf} onChange={setAsOf} />
      <Notice error={err || accounts.error} message={msg} />
      <Loading loading={accounts.loading} error="" />

      {ACCOUNT_TYPES.map((type) => {
        const rows = list.filter((a) => a.type === type);
        if (rows.length === 0) return null;
        return (
          <Card key={type} title={type === 'Income' ? 'Income accounts' : type === 'Expense' ? 'Expense accounts' : `${type}s`}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Code</th>
                  <th>Account</th>
                  <th>Used for</th>
                  <th style={numStyle}>Balance (Ksh)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} style={a.active ? undefined : { opacity: 0.55 }}>
                    <td className="text-muted">{a.code}</td>
                    <td>
                      {a.name} {a.system && <Tag>built-in</Tag>} {!a.active && <Tag>inactive</Tag>}
                    </td>
                    <td className="text-muted" style={{ fontSize: 12 }}>
                      {a.description}
                    </td>
                    <td style={numStyle}>{money(a.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}

      <Card title="Add an account" hint="Codes: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx–6xxx expenses.">
        <div style={{ display: 'grid', gridTemplateColumns: '0.7fr 1.6fr 1fr 2fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div className="field">
            <label>Code</label>
            <input className="input" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="e.g. 5210" />
          </div>
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="field">
            <label>Type</label>
            <select className="input" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {ACCOUNT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Description</label>
            <input className="input" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional" />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !form.code || !form.name} onClick={() => run(() => api.post('/accounting/accounts', form), 'Account added', () => setForm({ code: '', name: '', type: 'Expense', description: '' }))}>
            Add
          </button>
        </div>
      </Card>

      <Card title="Linking expenses and income to accounts" hint="Every expense head posts to an Expense account, and every service to an Income account — that is how spending and sales reach the right lines of the profit & loss.">
        {links.data && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}>
            <div>
              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
                Expense heads → Expense account
              </div>
              <table className="table">
                <tbody>
                  {links.data.expenseHeads.map((h) => (
                    <LinkRow key={h.id} label={h.name} current={h.accountId} options={expenseAccounts} onPick={(id) => run(() => api.put(`/accounting/links/expense-head/${h.id}`, { accountId: id }), `${h.name} linked`)} />
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                <input className="input" placeholder="New expense head, e.g. Packaging" value={newHead} onChange={(e) => setNewHead(e.target.value)} />
                <button type="button" className="btn btn-secondary" disabled={busy || !newHead.trim()} onClick={() => run(() => api.post('/finance/expense-heads', { name: newHead }), 'Expense head added with its own account', () => setNewHead(''))}>
                  Add head
                </button>
              </div>
            </div>
            <div>
              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
                Services → Income account
              </div>
              <table className="table">
                <tbody>
                  {links.data.services.map((s) => (
                    <LinkRow key={s.id} label={s.name} current={s.accountId} options={incomeAccounts} onPick={(id) => run(() => api.put(`/accounting/links/service/${s.id}`, { accountId: id }), `${s.name} linked`)} />
                  ))}
                </tbody>
              </table>
              <div className="card-kicker" style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>
                Materials sold → Income account
              </div>
              <table className="table">
                <tbody>
                  {links.data.materials.map((m) => (
                    <LinkRow key={m.id} label={m.name} current={m.accountId} allowDefault options={incomeAccounts} onPick={(id) => run(() => api.put(`/accounting/links/material/${m.id}`, { accountId: id }), `${m.name} linked`)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
