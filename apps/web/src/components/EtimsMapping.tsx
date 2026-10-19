import { useMemo, useRef, useState } from 'react';
import { api, downloadFile, uploadFile } from '../api/client';
import { Card, Loading, Notice, Tag, useLoad } from '../pages/accounting/shared';

// Master Data → eTIMS Codes (Admin): the KRA item class code, units and item type each business head, service and stock item is sold under. Phase 1 is the mapping only —
// nothing is sent to KRA. A line with no code of its own uses its business head's. Codes are proposed here as drafts and become "confirmed" once someone has checked them
// against the KRA portal's item-class search. Every sale is VAT type B (16%).

interface Own {
  clsCd: string;
  qtyUnit: string;
  pkgUnit: string;
  itemType: string;
  hsCode: string;
  status: string;
}
interface HeadRow {
  kind: 'head';
  id: number;
  name: string;
  active: boolean;
  own: Own;
  proposal: { clsCd: string; search: string };
  lines: number;
}
interface ItemRow {
  kind: 'service' | 'material';
  id: number;
  name: string;
  head: string;
  headId: number | null;
  unit: string;
  price: number;
  own: Own;
  eff: { clsCd: string; qtyUnit: string; pkgUnit: string; itemType: string; hsCode: string; from: 'item' | 'head' | null };
  ready: boolean;
  state: 'missing' | 'proposed' | 'confirmed';
  search: string;
}
interface Overview {
  taxType: string;
  heads: HeadRow[];
  items: ItemRow[];
  counts: { total: number; ready: number; missing: number; proposed: number; confirmed: number };
}
interface Check {
  dryRun: boolean;
  total: number;
  updated: number;
  unchanged: number;
  errors: { row: number; message: string }[];
}

const TYPES: [string, string][] = [
  ['', 'as the head'],
  ['service', 'Service'],
  ['finished', 'Finished product'],
  ['raw', 'Raw material'],
];
const input = { padding: '4px 6px', fontSize: 13, width: '100%', minWidth: 0 } as const;

type Draft = { clsCd: string; qtyUnit: string; pkgUnit: string; itemType: string; hsCode: string };
const draftOf = (o: Own): Draft => ({ clsCd: o.clsCd, qtyUnit: o.qtyUnit, pkgUnit: o.pkgUnit, itemType: o.itemType, hsCode: o.hsCode });

function StateTag({ state }: { state: 'missing' | 'proposed' | 'confirmed' }) {
  return state === 'confirmed' ? <Tag tone="good">Confirmed</Tag> : state === 'proposed' ? <Tag>Proposed</Tag> : <Tag tone="bad">Needs a code</Tag>;
}

export default function EtimsMapping() {
  const { data, error, loading, reload } = useLoad<Overview>('/etims/overview');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'missing' | 'proposed' | 'confirmed'>('all');
  const [headFilter, setHeadFilter] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ clsCd: '', qtyUnit: '', pkgUnit: '', itemType: '', hsCode: '' });
  const file = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ file: File; check: Check } | null>(null);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => (filter === 'all' || i.state === filter) && (!headFilter || i.head === headFilter) && (!term || i.name.toLowerCase().includes(term)));
  }, [data, filter, headFilter, q]);

  function say(m: string) {
    setMsg(m);
    setErr('');
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }
  const startEdit = (k: string, own: Own) => {
    setEditing(k);
    setDraft(draftOf(own));
  };
  const save = (kind: string, refId: number) =>
    run(async () => {
      await api.put('/etims/item', { kind, refId, ...draft });
      setEditing(null);
      say('Saved and confirmed.');
      reload();
    });

  const propose = () =>
    run(async () => {
      const r = await api.post<{ created: number; filled: number }>('/etims/propose');
      say(r.created + r.filled === 0 ? 'Nothing to add — the list is already filled in.' : `Proposed list applied (${r.created} added, ${r.filled} filled in). Nothing is confirmed until you confirm it.`);
      reload();
    });
  const confirm = (headId?: number) =>
    run(async () => {
      const r = await api.post<{ confirmed: number }>('/etims/confirm', headId ? { headId } : {});
      say(r.confirmed ? `${r.confirmed} confirmed.` : 'Nothing proposed with a code to confirm.');
      reload();
    });

  async function choose(f: File | undefined) {
    if (!f) return;
    await run(async () => {
      setUpload({ file: f, check: await uploadFile<Check>('/etims/mapping?dryRun=1', f) });
    });
    if (file.current) file.current.value = '';
  }
  const apply = () =>
    run(async () => {
      if (!upload) return;
      const r = await uploadFile<Check>('/etims/mapping', upload.file);
      setUpload(null);
      say(`Uploaded: ${r.updated} changed, ${r.unchanged} unchanged.`);
      reload();
    });

  const c = data?.counts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Loading loading={loading && !data} error={error} />
      <Notice error={err} message={msg} />
      {data && c && (
        <>
          <Card
            title="KRA eTIMS item codes"
            hint="Phase 1 — the mapping only. Nothing is sent to KRA yet. Every sale is VAT type B (16%)."
            actions={
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={propose} title="Fills in what is empty — never overwrites anything already there">
                  Use the proposed list
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || c.proposed === 0} onClick={() => confirm()} title="Confirms every proposed row that has a code — do this only after checking them against the KRA portal">
                  Confirm all proposed
                </button>
              </div>
            }
          >
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Tag tone="good">{c.confirmed} confirmed</Tag>
              <Tag>{c.proposed} proposed</Tag>
              <Tag tone={c.missing ? 'bad' : 'neutral'}>{c.missing} need a code</Tag>
              <span className="text-muted" style={{ fontSize: 12 }}>of {c.total} lines sold</span>
            </div>
            <p className="note" style={{ marginBottom: 0 }}>
              The proposed codes are <b>drafts, not KRA’s list</b>. Check each against the item-class search in the eTIMS portal (the words to search for are shown beside every line without a code), then confirm. KRA’s own codes may run to 10 digits. A line with no code of its own uses its
              business head’s, so most of the work is the head defaults below.
            </p>
          </Card>

          <Card title="Business head defaults" hint="The code, unit and type every line of the head uses unless it has its own.">
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Business head</th>
                    <th>Lines</th>
                    <th>Item class code</th>
                    <th>Unit</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Search the portal for</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.heads.map((h) => {
                    const k = `head:${h.id}`;
                    const open = editing === k;
                    return (
                      <tr key={k} style={h.active ? undefined : { opacity: 0.6 }}>
                        <td>
                          <b>{h.name}</b>
                        </td>
                        <td>{h.lines}</td>
                        {open ? (
                          <>
                            <td><input className="input" style={{ ...input, width: 130 }} aria-label={`${h.name} item class code`} value={draft.clsCd} onChange={(e) => setDraft({ ...draft, clsCd: e.target.value })} /></td>
                            <td><input className="input" style={{ ...input, width: 70 }} aria-label={`${h.name} unit`} value={draft.qtyUnit} onChange={(e) => setDraft({ ...draft, qtyUnit: e.target.value })} /></td>
                            <td>
                              <select className="input" style={input} value={draft.itemType} onChange={(e) => setDraft({ ...draft, itemType: e.target.value })}>
                                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select>
                            </td>
                            <td colSpan={2}></td>
                            <td>
                              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save('head', h.id)}>Save</button>{' '}
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{h.own.clsCd || <span className="text-muted">—</span>}</td>
                            <td>{h.own.qtyUnit || <span className="text-muted">—</span>}</td>
                            <td>{h.own.itemType || <span className="text-muted">—</span>}</td>
                            <td>{h.own.clsCd ? (h.own.status === 'confirmed' ? <Tag tone="good">Confirmed</Tag> : <Tag>Proposed</Tag>) : <Tag tone="bad">No default</Tag>}</td>
                            <td className="text-muted" style={{ fontSize: 12 }}>{h.own.clsCd ? '' : h.proposal.search}</td>
                            <td>
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(k, h.own)}>Edit</button>{' '}
                              {h.own.clsCd && h.own.status !== 'confirmed' && (
                                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => confirm(h.id)} title="Confirm this head's code and any of its lines that were proposed">
                                  Confirm
                                </button>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="Every service and stock item"
            hint="Leave a line’s own code blank to use its business head’s."
            actions={
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(() => downloadFile('/etims/mapping.xlsx', 'etims-item-codes.xlsx'))}>Download Excel</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => file.current?.click()}>Upload Excel</button>
                <input ref={file} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => choose(e.target.files?.[0])} />
              </div>
            }
          >
            {upload && (
              <div className="card" style={{ padding: 'var(--space-3)', marginBottom: 'var(--space-3)', maxWidth: 720 }}>
                <strong>{upload.file.name}</strong> — {upload.check.total} row{upload.check.total === 1 ? '' : 's'} read.
                <div style={{ marginTop: 'var(--space-1)' }}>
                  <Tag tone="good">{upload.check.updated} changed</Tag> <Tag>{upload.check.unchanged} unchanged</Tag>{' '}
                  {upload.check.errors.length > 0 && <Tag tone="bad">{upload.check.errors.length} not usable</Tag>}
                </div>
                {upload.check.errors.length > 0 && (
                  <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)', fontSize: 13 }}>
                    {upload.check.errors.slice(0, 15).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                    {upload.check.errors.length > 15 && <li>…and {upload.check.errors.length - 15} more</li>}
                  </ul>
                )}
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', alignItems: 'center' }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || upload.check.errors.length > 0 || upload.check.updated === 0} onClick={apply}>
                    Apply {upload.check.updated} change{upload.check.updated === 1 ? '' : 's'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUpload(null)}>Cancel</button>
                  {upload.check.errors.length > 0 && <span className="text-muted" style={{ fontSize: 12 }}>Fix the rows listed and upload again — nothing is saved until every row is usable.</span>}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
              <div className="btn-group" role="group" aria-label="Show">
                {([['all', 'All'], ['missing', 'Need a code'], ['proposed', 'Proposed'], ['confirmed', 'Confirmed']] as const).map(([v, l]) => (
                  <button key={v} type="button" className={'btn btn-sm ' + (filter === v ? 'btn-primary' : 'btn-secondary')} onClick={() => setFilter(v)}>{l}</button>
                ))}
              </div>
              <select className="input" style={{ width: 'auto' }} aria-label="Business head" value={headFilter} onChange={(e) => setHeadFilter(e.target.value)}>
                <option value="">All business heads</option>
                {data.heads.map((h) => <option key={h.id} value={h.name}>{h.name}</option>)}
              </select>
              <input className="input" style={{ width: 200 }} placeholder="Search by name" aria-label="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
              <span className="text-muted" style={{ fontSize: 12 }}>{items.length} shown</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Head</th>
                    <th>Sold per</th>
                    <th>Item class code</th>
                    <th>Unit</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => {
                    const k = `${i.kind}:${i.id}`;
                    const open = editing === k;
                    return (
                      <tr key={k}>
                        <td>
                          {i.name} <span className="text-muted" style={{ fontSize: 11 }}>{i.kind === 'service' ? 'service' : 'stock'}</span>
                        </td>
                        <td>{i.head || <span className="text-muted">—</span>}</td>
                        <td>{i.unit}</td>
                        {open ? (
                          <>
                            <td>
                              <input className="input" style={{ ...input, width: 130 }} aria-label={`${i.name} item class code`} placeholder={i.eff.from === 'head' ? i.eff.clsCd + ' (head)' : 'uses the head’s'} value={draft.clsCd} onChange={(e) => setDraft({ ...draft, clsCd: e.target.value })} />
                              <input className="input" style={{ ...input, width: 130, marginTop: 4 }} aria-label={`${i.name} HS code`} placeholder="HS code (imports)" value={draft.hsCode} onChange={(e) => setDraft({ ...draft, hsCode: e.target.value })} />
                            </td>
                            <td>
                              <input className="input" style={{ ...input, width: 70 }} aria-label={`${i.name} unit code`} placeholder={i.eff.qtyUnit} value={draft.qtyUnit} onChange={(e) => setDraft({ ...draft, qtyUnit: e.target.value })} />
                              <input className="input" style={{ ...input, width: 70, marginTop: 4 }} aria-label={`${i.name} packaging unit`} placeholder="Pkg" value={draft.pkgUnit} onChange={(e) => setDraft({ ...draft, pkgUnit: e.target.value })} />
                            </td>
                            <td>
                              <select className="input" style={input} value={draft.itemType} onChange={(e) => setDraft({ ...draft, itemType: e.target.value })}>
                                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select>
                            </td>
                            <td></td>
                            <td>
                              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(i.kind, i.id)}>Save</button>{' '}
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              {i.eff.clsCd ? (
                                <>
                                  {i.eff.clsCd} {i.eff.from === 'head' && <span className="text-muted" style={{ fontSize: 11 }}>(head)</span>}
                                </>
                              ) : (
                                <span className="text-muted" style={{ fontSize: 12 }}>{i.search ? `search: ${i.search}` : '—'}</span>
                              )}
                            </td>
                            <td>{i.eff.qtyUnit || <span className="text-muted">—</span>}</td>
                            <td>{i.eff.itemType || <span className="text-muted">—</span>}</td>
                            <td><StateTag state={i.state} /></td>
                            <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(k, i.own)}>Edit</button></td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-muted">Nothing to show with these filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
