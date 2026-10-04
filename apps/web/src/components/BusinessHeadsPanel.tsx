import { useState } from 'react';
import { api } from '../api/client';
import type { BusinessHeadRow } from '../api/models';
import { Notice } from '../pages/accounting/shared';

// Business heads (Master Data): the lines of business income is reported under. Every service belongs to one; a material sold over
// the counter counts as General Order. Admin can add heads, rename them, take one out of use or remove an empty one.
export default function BusinessHeadsPanel({ heads, onChanged }: { heads: BusinessHeadRow[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        Income is reported by business head (Reports → Sales by business head). Choose each service’s head in the Services tab; a material sold over the counter counts as General Order.
      </p>
      <Notice error={err} message={msg} />
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ maxWidth: 640 }}>
          <thead>
            <tr>
              <th>Business head</th>
              <th style={{ textAlign: 'right' }}>Services</th>
              <th>In use</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {heads.map((h) => (
              <tr key={h.id}>
                <td>
                  <input
                    className="input"
                    defaultValue={h.name}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== h.name) run(async () => { await api.put(`/master-data/business-heads/${h.id}`, { name: v }); return 'Renamed'; });
                      else e.target.value = h.name;
                    }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>{h.services}</td>
                <td>
                  <input type="checkbox" checked={h.active} disabled={busy} onChange={(e) => run(async () => { await api.put(`/master-data/business-heads/${h.id}`, { active: e.target.checked }); return e.target.checked ? 'Back in use' : 'Taken out of use'; })} />
                </td>
                <td>
                  {h.services === 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { await api.del(`/master-data/business-heads/${h.id}`); return `${h.name} removed`; })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>New business head</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Signage" />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !name.trim()}
          onClick={() => run(async () => { await api.post('/master-data/business-heads', { name: name.trim() }); setName(''); return 'Business head added'; })}
        >
          Add
        </button>
      </div>
    </div>
  );
}
