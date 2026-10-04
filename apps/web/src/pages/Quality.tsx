import { Fragment, useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../api/client';
import { HeadRow, HeadTitle, groupByHead } from '../components/HeadGroups';
import { Card, DateRangeBar, Loading, Notice, Tag, numStyle, useLoad, useRange } from './accounting/shared';

// Quality control: every finished order is inspected before it can go to the customer. A pass makes it "Ready for Pickup /
// Delivery"; a fail sends it back to Production as rework. The person who made a job can't be the one who passes it. Nothing here
// completes an order — completion is the customer handover (on the order itself).

interface Awaiting {
  orderId: number;
  orderNo: string;
  customer: string;
  channel: string;
  businessHead: string;
  items: { name: string; qty: number }[];
  units: number;
  producerName: string;
  finishedAt: string | null;
  unitsCompleted: number | null;
  isRework: boolean;
  canInspect: boolean;
}
interface History {
  id: number;
  orderNo: string;
  businessHead: string;
  result: 'Passed' | 'Failed';
  checkedAt: string;
  inspectorName: string;
  producerName: string;
  unitsInspected: number | null;
  unitsRejected: number;
  defects: string;
  note: string;
  isRework: boolean;
}
interface QueueData {
  awaiting: Awaiting[];
  history: History[];
  stats: { checked: number; passed: number; failed: number; passPct: number | null; rejectedUnits: number };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Quality() {
  const range = useRange();
  const { data, error, loading, reload } = useLoad<QueueData>(`/quality/queue?from=${range.from}&to=${range.to}`);
  const [open, setOpen] = useState<number | null>(null);
  const [result, setResult] = useState<'Passed' | 'Failed'>('Passed');
  const [inspected, setInspected] = useState('');
  const [rejected, setRejected] = useState('');
  const [defects, setDefects] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function begin(o: Awaiting) {
    setOpen(o.orderId);
    setResult('Passed');
    setInspected(o.unitsCompleted != null ? String(o.unitsCompleted) : '');
    setRejected('');
    setDefects('');
    setNote('');
    setErr('');
  }

  async function submit(o: Awaiting) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.post(`/quality/orders/${o.orderId}/check`, {
        result,
        unitsInspected: inspected === '' ? null : Number(inspected),
        unitsRejected: rejected === '' ? 0 : Number(rejected),
        defects,
        note,
      });
      setMsg(result === 'Passed' ? `${o.orderNo} passed — ready for pickup / delivery` : `${o.orderNo} failed — sent back to ${o.producerName} as rework`);
      setOpen(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Notice error={err || error} message={msg} />
      <Loading loading={loading && !data} error="" />
      {data && (
        <>
          <Card title={`Awaiting inspection (${data.awaiting.length})`} hint="Finished by Production and waiting for a quality check. A pass makes the order ready for the customer; a fail sends it back as rework.">
            {data.awaiting.length === 0 && <p className="note">Nothing waiting for inspection.</p>}
            {groupByHead(data.awaiting).map(([head, rows]) => (
              <Fragment key={head}>
                <HeadTitle head={head} count={rows.length} />
                {rows.map((o) => (
              <div key={o.orderId} style={{ borderTop: '1px solid var(--color-divider)', padding: 'var(--space-3) 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <strong>{o.orderNo}</strong> — {o.customer} {o.channel === 'dtf' && <Tag>DTF</Tag>} {o.isRework && <Tag tone="bad">rework</Tag>}
                    <div className="note">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</div>
                    <div className="note">
                      Made by <strong>{o.producerName}</strong>
                      {o.finishedAt ? ` · finished ${when(o.finishedAt)}` : ''}
                      {o.unitsCompleted != null ? ` · ${o.unitsCompleted} of ${o.units} units reported` : ''}
                    </div>
                  </div>
                  {open !== o.orderId &&
                    (o.canInspect ? (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => begin(o)}>
                        Inspect
                      </button>
                    ) : (
                      <span className="note">You made this job — someone else has to inspect it.</span>
                    ))}
                </div>

                {open === o.orderId && (
                  <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                    <div className="seg" style={{ marginBottom: 'var(--space-3)' }}>
                      <label className={'seg-opt' + (result === 'Passed' ? ' checked' : '')}>
                        <input type="radio" checked={result === 'Passed'} onChange={() => setResult('Passed')} />
                        Pass
                      </label>
                      <label className={'seg-opt' + (result === 'Failed' ? ' checked' : '')}>
                        <input type="radio" checked={result === 'Failed'} onChange={() => setResult('Failed')} />
                        Fail — send back
                      </label>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr 2fr', gap: 'var(--space-3)' }}>
                      <div className="field">
                        <label>Units inspected</label>
                        <input className="input" inputMode="decimal" value={inspected} onChange={(e) => setInspected(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>Units rejected</label>
                        <input className="input" inputMode="decimal" value={rejected} onChange={(e) => setRejected(e.target.value)} placeholder="0" />
                      </div>
                      <div className="field">
                        <label>{result === 'Failed' ? 'What is wrong (required)' : 'Defects noticed (optional)'}</label>
                        <input className="input" value={defects} onChange={(e) => setDefects(e.target.value)} placeholder="e.g. print misaligned, wrong colour" />
                      </div>
                      <div className="field">
                        <label>Note</label>
                        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                      <button type="button" className="btn btn-primary" disabled={busy || (result === 'Failed' && !(defects || note).trim())} onClick={() => submit(o)}>
                        {result === 'Passed' ? 'Pass — ready for pickup / delivery' : `Fail — send back to ${o.producerName}`}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setOpen(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
                ))}
              </Fragment>
            ))}
          </Card>

          <DateRangeBar range={range} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
            {[
              ['Checks done', String(data.stats.checked)],
              ['Pass rate', data.stats.passPct == null ? '—' : `${data.stats.passPct}%`],
              ['Failed', String(data.stats.failed)],
              ['Units rejected', String(data.stats.rejectedUnits)],
            ].map(([k, v]) => (
              <div key={k} className="card blueprint elev-sm">
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                <div className="card-kicker">{k}</div>
                <div className="card-title">{v}</div>
              </div>
            ))}
          </div>

          <Card title="Inspection history">
            <table className="table">
              <thead>
                <tr>
                  <th>Checked</th>
                  <th>Order</th>
                  <th>Result</th>
                  <th>Made by</th>
                  <th>Inspector</th>
                  <th style={numStyle}>Inspected</th>
                  <th style={numStyle}>Rejected</th>
                  <th>Findings</th>
                </tr>
              </thead>
              <tbody>
                {data.history.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted">
                      No inspections in this period.
                    </td>
                  </tr>
                )}
                {groupByHead(data.history).map(([head, rows]) => (
                  <Fragment key={head}>
                    <HeadRow head={head} count={rows.length} cols={8} />
                    {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="text-muted">{when(c.checkedAt)}</td>
                    <td>
                      {c.orderNo} {c.isRework && <Tag>rework</Tag>}
                    </td>
                    <td>
                      <Tag tone={c.result === 'Passed' ? 'good' : 'bad'}>{c.result}</Tag>
                    </td>
                    <td>{c.producerName || '—'}</td>
                    <td>{c.inspectorName}</td>
                    <td style={numStyle}>{c.unitsInspected ?? '—'}</td>
                    <td style={numStyle}>{c.unitsRejected || '—'}</td>
                    <td className="text-muted" style={{ fontSize: 12 }}>
                      {[c.defects, c.note].filter(Boolean).join(' — ') || '—'}
                    </td>
                  </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {data && <span className="note">{fmtDate(range.from)} to {fmtDate(range.to)}</span>}
    </div>
  );
}
