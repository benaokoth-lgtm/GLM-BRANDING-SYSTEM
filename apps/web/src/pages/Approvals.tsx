import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { approvalsChanged, markApprovalsSeen } from '../hooks/useApprovals';

// Approvals: one inbox for everything that waits for somebody's decision — a quote's price, a price below the recommended one, a unit price discount, an expense correction, a deletion, a stock
// requisition, leave. "Waiting for me" is what this person may decide (never their own requests); "My requests" is how their own went. Deciding is done by each kind's own endpoint, so each
// keeps its own rules; leave is opened on the People (HR) page, where a decision can need a confirmation.

interface Item {
  key: string;
  source: string;
  sourceLabel: string;
  origin: string;
  originLabel: string;
  originOrder: number;
  title: string;
  detail: string;
  amount: number | null;
  requestedByName: string;
  requestedAt: string;
  status: string;
  decidedByName: string | null;
  decidedAt: string | null;
  note: string | null;
  link: string;
  decide: { approve: string; reject: string; needsReason: boolean } | null;
}
interface Data {
  waiting: Item[];
  mine: Item[];
  emailOn: boolean;
}

// what each head holds (the heads are the screens the requests were raised on)
const ABOUT: Record<string, string> = {
  general: 'Requests raised on the General Order screen.',
  dtf_film: 'Requests raised on the DTF Film Order screen.',
  dtf_artwork: 'DTF artwork jobs priced below the recommended price; they cannot be paid for or produced until approved.',
  uv_film: 'UV Pen Costing and UV Flatbed: discounts on the price of each piece.',
  uv_artwork: 'UV DTF artwork jobs priced below the recommended price; they cannot be paid for or produced until approved.',
  embroidery: 'Embroidery jobs priced below the recommended price; they cannot be paid for or produced until approved.',
  costing: 'A price agreed with a client that is under the lowest allowed without approval.',
  finance: 'Changes to recorded expenses, and expenses, payroll entries or petty cash top-ups someone asks to remove.',
  stock: 'Materials someone asks to buy.',
  hr: 'Time off asked for. It is decided on the People (HR) page, where it can ask you to confirm.',
};

const when = (iso: string) => fmtDate(iso.slice(0, 10));
const tone = (s: string) => (s === 'Approved' || s === 'Used' ? 'tag-accent' : 'tag-outline');

export default function Approvals() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<'waiting' | 'mine'>('waiting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<{ key: string; reason: string } | null>(null);

  const load = useCallback(() => {
    api
      .get<Data>('/approvals')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the approvals'));
  }, []);
  useEffect(load, [load]);
  // opening "My requests" is looking at the decisions on them
  useEffect(() => {
    if (tab === 'mine') markApprovalsSeen();
  }, [tab, data]);

  async function decide(item: Item, approve: boolean, reason = '') {
    if (!item.decide) return;
    setBusy(item.key);
    setError('');
    try {
      await api.post(approve ? item.decide.approve : item.decide.reject, approve ? {} : { reason });
      setRejecting(null);
      load();
      approvalsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the decision');
    } finally {
      setBusy('');
    }
  }
  async function setEmail(on: boolean) {
    try {
      await api.put('/approvals/email', { on });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the setting');
    }
  }

  if (!data) return <p className="note">{error || 'Loading…'}</p>;
  const list = tab === 'waiting' ? data.waiting : data.mine;
  // one section for each place the requests were raised, in the order of the menu, each under its own heading
  const heads = [...new Map(list.map((i) => [i.origin, { origin: i.origin, head: i.originLabel, order: i.originOrder }])).values()].sort((a, b) => a.order - b.order);
  const sections = heads.map((h) => ({ ...h, about: ABOUT[h.origin] ?? '', items: list.filter((i) => i.origin === h.origin) }));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ margin: 0 }}>Approvals</h1>
        <p className="note" style={{ margin: '4px 0 0' }}>Everything that waits for a decision, in one place. You never decide your own request.</p>
      </div>

      <div className="seg" role="radiogroup" aria-label="Approvals" style={{ maxWidth: 440 }}>
        <label className={'seg-opt' + (tab === 'waiting' ? ' checked' : '')}>
          <input type="radio" name="aptab" checked={tab === 'waiting'} onChange={() => setTab('waiting')} />
          Waiting for me ({data.waiting.length})
        </label>
        <label className={'seg-opt' + (tab === 'mine' ? ' checked' : '')}>
          <input type="radio" name="aptab" checked={tab === 'mine'} onChange={() => setTab('mine')} />
          My requests ({data.mine.length})
        </label>
      </div>

      {sections.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {sections.map((h) => (
            <a key={h.origin} href={'#ap-' + h.origin} className="btn btn-secondary btn-sm">{h.head} ({h.items.length})</a>
          ))}
        </div>
      )}
      {error && <p className="note" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}

      {list.length === 0 && (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>{tab === 'waiting' ? 'Nothing is waiting for your decision.' : 'You have no requests waiting, and none decided in the last two weeks.'}</p>
        </div>
      )}

      {sections.map((h) => (
        <section key={h.origin} id={'ap-' + h.origin} style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div style={{ borderBottom: '2px solid var(--color-divider)', paddingBottom: 6 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{h.head} <span className="text-muted" style={{ fontWeight: 400 }}>({h.items.length})</span></h2>
            <div className="text-muted" style={{ fontSize: 13 }}>{h.about}</div>
          </div>
      {h.items.map((i) => (
        <div key={i.key} className="card" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div>
              <span className="tag tag-outline">{i.sourceLabel}</span> <b style={{ marginLeft: 6 }}>{i.title}</b>
            </div>
            <span className="text-muted" style={{ fontSize: 13 }}>{tab === 'waiting' ? `asked by ${i.requestedByName} on ${when(i.requestedAt)}` : `asked on ${when(i.requestedAt)}`}</span>
          </div>
          <div>{i.detail}</div>
          {i.amount != null && i.source !== 'leave' && <div className="text-muted" style={{ fontSize: 13 }}>{i.source === 'artwork' ? 'Given away' : i.source === 'amend' ? 'Change' : 'Value'}: {fmtKsh(i.amount)}</div>}

          {tab === 'mine' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={'tag ' + tone(i.status)}>{i.status === 'Pending' ? 'Waiting for a decision' : i.status === 'Used' ? 'Approved and used' : i.status}</span>
              {i.decidedByName && <span className="text-muted" style={{ fontSize: 13 }}>by {i.decidedByName}{i.decidedAt ? ` on ${when(i.decidedAt)}` : ''}</span>}
              {i.note && <span style={{ fontSize: 13 }}>“{i.note}”</span>}
              <Link to={i.link} className="btn btn-ghost btn-sm">Open</Link>
            </div>
          )}

          {tab === 'waiting' && (
            <div style={{ display: 'grid', gap: 8 }}>
              {rejecting?.key === i.key ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder={i.decide?.needsReason ? 'Why it is turned down (needed)' : 'Why it is turned down (optional)'} value={rejecting.reason} onChange={(e) => setRejecting({ key: i.key, reason: e.target.value })} aria-label="Reason for turning it down" />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || (!!i.decide?.needsReason && rejecting.reason.trim().length < 3)} onClick={() => decide(i, false, rejecting.reason.trim())}>Turn down</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(null)}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {i.decide ? (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => decide(i, true)}>Approve</button>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => setRejecting({ key: i.key, reason: '' })}>Turn down</button>
                    </>
                  ) : (
                    <span className="text-muted" style={{ fontSize: 13, alignSelf: 'center' }}>Decided on its own page, where it can ask you to confirm.</span>
                  )}
                  <Link to={i.link} className="btn btn-ghost btn-sm">Open</Link>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
        </section>
      ))}

      {isAdmin && (
        <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="checkbox" checked={data.emailOn} onChange={(e) => setEmail(e.target.checked)} aria-label="Email approvers when a request is raised" />
            <span>Email the people who can decide when a new request is raised</span>
          </label>
          <span className="text-muted" style={{ fontSize: 13 }}>Needs email set up under Master Data, and an email address on the person (Master Data → Staff &amp; Users). Everyone also sees the number in the menu.</span>
        </div>
      )}
    </div>
  );
}
