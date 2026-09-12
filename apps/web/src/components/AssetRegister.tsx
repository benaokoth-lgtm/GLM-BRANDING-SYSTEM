import { useEffect, useState } from 'react';
import { ASSET_CATEGORIES, ASSET_CONDITIONS, fmtDate, fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import type { AssetRow } from '../api/models';
import { useAuth } from '../state/AuthContext';

const emptyForm = {
  tag: '',
  name: '',
  category: ASSET_CATEGORIES[0] as string,
  quantity: '1',
  location: '',
  purchaseDate: '',
  value: '',
  notes: '',
};

// Fixed-asset tracking (machines, vehicles, computers, furniture) — modeled
// on the Olerai Hotel System's own Asset Register (same machine, sibling
// project): a tag/name/category/quantity/location record with a condition
// lifecycle (Active/Under Repair/Retired) changed directly, no approval
// workflow, since this is routine record-keeping rather than a spend
// decision. Lives as a Finance tab alongside Quotation/Invoice/Expenses/etc.
export default function AssetRegister() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (categoryFilter) params.set('category', categoryFilter);
    if (conditionFilter) params.set('condition', conditionFilter);
    api
      .get<AssetRow[]>(`/assets?${params.toString()}`)
      .then(setAssets)
      .finally(() => setLoading(false));
  }

  useEffect(load, [categoryFilter, conditionFilter]);

  function startEdit(a: AssetRow) {
    setEditingId(a.id);
    setForm({
      tag: a.tag,
      name: a.name,
      category: a.category,
      quantity: String(a.quantity),
      location: a.location,
      purchaseDate: a.purchaseDate ?? '',
      value: a.value != null ? String(a.value) : '',
      notes: a.notes,
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function saveAsset() {
    if (!form.tag.trim() || !form.name.trim()) return setError('Asset tag and name are required');
    setError(null);
    setBusy(true);
    const payload = {
      tag: form.tag,
      name: form.name,
      category: form.category,
      quantity: Number(form.quantity) || 1,
      location: form.location,
      purchaseDate: form.purchaseDate || undefined,
      value: form.value ? Number(form.value) : undefined,
      notes: form.notes,
    };
    try {
      if (editingId) {
        await api.put(`/assets/${editingId}`, payload);
      } else {
        await api.post('/assets', payload);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save asset');
    } finally {
      setBusy(false);
    }
  }

  async function setCondition(id: number, condition: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/assets/${id}/condition`, { condition });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update condition');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAsset(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/assets/${id}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete asset');
    } finally {
      setBusy(false);
    }
  }

  const counts = ASSET_CONDITIONS.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: assets.filter((a) => a.condition === c).length }), {});
  const totalValue = assets.reduce((a, r) => a + (r.value ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)' }}>
        {ASSET_CONDITIONS.map((c) => (
          <div key={c} className="card blueprint elev-sm">
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-kicker">{c}</div>
            <div className="card-title">{counts[c] || 0}</div>
          </div>
        ))}
        <div className="card blueprint elev-sm">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <div className="card-kicker">Total recorded value</div>
          <div className="card-title">{fmtKsh(totalValue)}</div>
        </div>
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      <div className="card blueprint no-print" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          {editingId ? 'Edit asset' : 'Add asset'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1.2fr 0.7fr', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
          <div className="field">
            <label>Asset tag</label>
            <input className="input" value={form.tag} onChange={(e) => setForm((f) => ({ ...f, tag: e.target.value }))} placeholder="e.g. AST-0001" />
          </div>
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Epson DTF Printer" />
          </div>
          <div className="field">
            <label>Category</label>
            <select className="input" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Quantity</label>
            <input className="input" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1.6fr', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-3)' }}>
          <div className="field">
            <label>Location</label>
            <input className="input" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Production floor" />
          </div>
          <div className="field">
            <label>Purchase date</label>
            <input className="input" type="date" value={form.purchaseDate} onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
          </div>
          <div className="field">
            <label>Value (Ksh)</label>
            <input className="input" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="Optional" />
          </div>
          <div className="field">
            <label>Notes</label>
            <input className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-primary blueprint" onClick={saveAsset} disabled={busy}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {editingId ? 'Save changes' : 'Add asset'}
          </button>
          {editingId && (
            <button type="button" className="btn btn-secondary" onClick={cancelEdit} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="card blueprint" style={{ padding: 'var(--space-4)' }}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <div className="card-title">Asset register</div>
          <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <select className="input" style={{ width: 'auto' }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">All categories</option>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select className="input" style={{ width: 'auto' }} value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
              <option value="">All conditions</option>
              {ASSET_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Name</th>
                <th>Category</th>
                <th>Location</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Value</th>
                <th>Purchased</th>
                <th>Condition</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td className="text-muted">{a.tag}</td>
                  <td>
                    {a.name}
                    {a.notes && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {a.notes}
                      </div>
                    )}
                  </td>
                  <td className="text-muted">{a.category}</td>
                  <td className="text-muted">{a.location || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{a.quantity}</td>
                  <td style={{ textAlign: 'right' }}>{a.value != null ? fmtKsh(a.value) : '—'}</td>
                  <td className="text-muted">{a.purchaseDate ? fmtDate(a.purchaseDate) : '—'}</td>
                  <td>
                    <span className={a.condition === 'Active' ? 'tag tag-accent' : a.condition === 'Retired' ? 'tag tag-neutral' : 'tag tag-outline'}>{a.condition}</span>
                  </td>
                  <td className="no-print">
                    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {a.condition === 'Active' && (
                        <>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setCondition(a.id, 'Under Repair')} disabled={busy}>
                            Repair
                          </button>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setCondition(a.id, 'Retired')} disabled={busy}>
                            Retire
                          </button>
                        </>
                      )}
                      {a.condition === 'Under Repair' && (
                        <>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setCondition(a.id, 'Active')} disabled={busy}>
                            Mark active
                          </button>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setCondition(a.id, 'Retired')} disabled={busy}>
                            Retire
                          </button>
                        </>
                      )}
                      {a.condition === 'Retired' && (
                        <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setCondition(a.id, 'Active')} disabled={busy}>
                          Reactivate
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => startEdit(a)} disabled={busy}>
                        Edit
                      </button>
                      {isAdmin && (
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Delete" onClick={() => deleteAsset(a.id)} disabled={busy}>
                          ✕
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && assets.length === 0 && <p className="note">No assets recorded yet.</p>}
      </div>
    </div>
  );
}
