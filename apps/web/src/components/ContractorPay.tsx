import { useState } from 'react';
import { EXPENSE_METHODS } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { notifyFeaturesChanged } from '../hooks/useFeatures';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Commission → Pay details: how sales persons are paid once they are contractors. Admin sets the month it starts and the standard withholding tax rate; a manager sees each sales person's pay
// details — where their money goes, their KRA PIN and National ID (the ones on their staff record), the tax rate that applies to them and whether a month below the minimum wage is topped up.

interface Person {
  staffId: number;
  name: string;
  role: string;
  kraPin: string;
  nationalId: string;
  phone: string;
  mpesaNumber: string;
  payMethod: string;
  bankName: string;
  bankAccount: string;
  whtRate: number | null;
  effectiveWhtRate: number;
  minWageFloor: boolean;
  /** Captures their own orders too; off = only the front office captures for them. */
  capturesOwn: boolean;
  note: string;
  missing: string[];
}
interface Data {
  standardWhtRate: number;
  contractorFrom: string;
  people: Person[];
}

function Switch() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const { data, error, loading, reload } = useLoad<Data>('/commission/contractors');
  const [from, setFrom] = useState<string | null>(null);
  const [rate, setRate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const [err, setErr] = useState<string | undefined>();
  if (!data) return <Loading loading={loading} error={error} />;
  const fromV = from ?? data.contractorFrom;
  const rateV = rate ?? String(data.standardWhtRate);
  const changed = fromV !== data.contractorFrom || Number(rateV) !== data.standardWhtRate;

  async function save(nextFrom: string) {
    setBusy(true);
    setErr(undefined);
    setMsg(undefined);
    try {
      const cur = await api.get<{ generalBands: unknown; filmBands: unknown; artworkRatePct: number; ownershipMonths: number }>('/commission/settings');
      await api.put('/commission/settings', { generalBands: cur.generalBands, filmBands: cur.filmBands, artworkRatePct: cur.artworkRatePct, ownershipMonths: cur.ownershipMonths, contractorFrom: nextFrom, freelanceWhtRate: Number(rateV) || 0 });
      setFrom(null);
      setRate(null);
      reload();
      notifyFeaturesChanged();
      setMsg(nextFrom ? `Saved. Sales persons are paid as contractors from ${nextFrom}.` : 'Saved. Sales persons are not paid as contractors (nothing changes from today’s way).');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Paying sales persons as contractors"
      hint="From the month you choose, a sales person’s month — the pay bands, the film and artwork premium and any commission — is one total with withholding tax taken off it, paid outside payroll (by M-Pesa to their phone or by hand). Before that month nothing changes. From it, freelance accounts are retired and every Freelancer Sales order is the sales person it is credited to."
    >
      <Notice error={err} message={msg} />
      {data.contractorFrom ? <p style={{ marginTop: 0 }}><Tag tone="good">on from {data.contractorFrom}</Tag></p> : <p style={{ marginTop: 0 }}><Tag>not switched on</Tag></p>}
      <fieldset disabled={!isAdmin || busy} style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Contractors from the month</label>
          <input className="input" type="month" value={fromV} onChange={(e) => setFrom(e.target.value)} aria-label="Contractors from the month" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Standard withholding tax (%)</label>
          <input className="input" style={{ maxWidth: 110 }} inputMode="decimal" value={rateV} onChange={(e) => setRate(e.target.value)} aria-label="Standard withholding tax rate" />
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!changed || (fromV !== '' && !/^\d{4}-\d{2}$/.test(fromV))} onClick={() => save(fromV)}>
          Save
        </button>
        {data.contractorFrom && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => save('')}>
            Switch off
          </button>
        )}
      </fieldset>
      {!isAdmin && <p className="note">Only an Admin can change these. Managers keep each person’s pay details below.</p>}
      <p className="note" style={{ marginBottom: 0 }}>
        The standard rate is 5% until you set another — confirm it, and how the tax authority will see paying sales persons this way, with your accountant. A person’s own rate (for example 0% with an exemption
        certificate) is set in their pay details below. Choose a month that has not begun, so no month is part one way and part the other.
      </p>
    </Card>
  );
}

function PersonRow({ p, standard, onSaved }: { p: Person; standard: number; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ kraPin: p.kraPin, nationalId: p.nationalId, phone: p.phone, mpesaNumber: p.mpesaNumber, payMethod: p.payMethod, bankName: p.bankName, bankAccount: p.bankAccount, whtRate: p.whtRate == null ? '' : String(p.whtRate), minWageFloor: p.minWageFloor, capturesOwn: p.capturesOwn, note: p.note });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setErr('');
    try {
      await api.put(`/commission/contractors/${p.staffId}`, { ...f, whtRate: f.whtRate.trim() === '' ? null : Number(f.whtRate) });
      setEdit(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td><b>{p.name}</b></td>
        <td>{p.kraPin || <Tag tone="bad">missing</Tag>}</td>
        <td>{p.nationalId || <Tag tone="bad">missing</Tag>}</td>
        <td>{p.mpesaNumber || p.phone || <Tag tone="bad">missing</Tag>}</td>
        <td>{p.payMethod}</td>
        <td style={{ textAlign: 'right' }}>{p.effectiveWhtRate}%{p.whtRate == null ? <span className="text-muted" style={{ fontSize: 11 }}> standard</span> : p.whtRate === 0 ? <span className="text-muted" style={{ fontSize: 11 }}> exempt</span> : null}</td>
        <td>{p.minWageFloor ? <Tag tone="good">topped up</Tag> : <span className="text-muted">no</span>}</td>
        <td>{p.capturesOwn ? <Tag tone="good">yes</Tag> : <span className="text-muted">front office only</span>}</td>
        <td>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(!edit)}>
            {edit ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {edit && (
        <tr>
          <td colSpan={9} style={{ background: 'var(--color-surface-2, transparent)' }}>
            <div style={{ padding: 'var(--space-3)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--space-3)' }}>
              {([['kraPin', 'KRA PIN'], ['nationalId', 'National ID'], ['phone', 'Phone (07… or 2547…)'], ['mpesaNumber', 'M-Pesa number (if different)'], ['bankName', 'Bank'], ['bankAccount', 'Bank account']] as const).map(([k, label]) => (
                <div className="field" style={{ margin: 0 }} key={k}>
                  <label>{label}</label>
                  <input className="input" value={f[k]} onChange={set(k)} aria-label={`${label} of ${p.name}`} />
                </div>
              ))}
              <div className="field" style={{ margin: 0 }}>
                <label>How they like to be paid</label>
                <select className="input" value={f.payMethod} onChange={set('payMethod')}>
                  {EXPENSE_METHODS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Withholding tax (%) — blank = standard {standard}%, 0 = exempt</label>
                <input className="input" inputMode="decimal" value={f.whtRate} onChange={set('whtRate')} aria-label={`Withholding tax rate of ${p.name}`} />
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', alignSelf: 'end' }}>
                <input type="checkbox" checked={f.minWageFloor} onChange={(e) => setF({ ...f, minWageFloor: e.target.checked })} aria-label={`Top up to the minimum wage for ${p.name}`} />
                Top a month up to the minimum wage
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', alignSelf: 'end' }}>
                <input type="checkbox" checked={f.capturesOwn} onChange={(e) => setF({ ...f, capturesOwn: e.target.checked })} aria-label={`${p.name} captures their own orders`} />
                Captures their own orders (the front office can too)
              </label>
              <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
                <label>Note</label>
                <input className="input" value={f.note} onChange={set('note')} />
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
                {err && <span className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{err}</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function ContractorPay() {
  const { data, error, loading, reload } = useLoad<Data>('/commission/contractors');
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Switch />
      <Card title="Sales persons’ pay details" hint="Everything a contractor payment needs. A person without a KRA PIN, National ID or M-Pesa number can still be paid, but the tax withheld cannot be certified for them and an M-Pesa payment cannot be sent.">
        {!data ? (
          <Loading loading={loading} error={error} />
        ) : data.people.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>No role is marked “can be assigned orders” yet, so there are no sales persons (Master Data → Roles &amp; Access).</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th>Sales person</th>
                  <th>KRA PIN</th>
                  <th>National ID</th>
                  <th>M-Pesa</th>
                  <th>Paid by</th>
                  <th style={{ textAlign: 'right' }}>Tax withheld</th>
                  <th>Minimum wage</th>
                  <th>Captures own orders</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <PersonRow key={p.staffId} p={p} standard={data.standardWhtRate} onSaved={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginBottom: 0 }}>Their pay for a month, with the tax withheld and what they receive, is under <b>Team &amp; payouts</b> once the month is over. The tax is booked as Withholding Tax Payable and shown under <b>Freelancers → Tax withheld</b> for KRA.</p>
      </Card>
    </div>
  );
}
