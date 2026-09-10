import { useState } from 'react';
import { fmtKsh } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';

type MasterTab = 'staff' | 'services' | 'materials' | 'clients' | 'discount';

const TABS: [MasterTab, string][] = [
  ['staff', 'Staff & Users'],
  ['services', 'Service Price List'],
  ['materials', 'Material Price List'],
  ['clients', 'Corporate Clients'],
  ['discount', 'Discount Rules'],
];

export default function MasterData() {
  const catalog = useCatalog();
  const [tab, setTab] = useState<MasterTab>('staff');

  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffRole, setNewStaffRole] = useState<'Staff' | 'Supervisor' | 'Admin'>('Staff');
  const [newStaffPin, setNewStaffPin] = useState('');

  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceUnit, setNewServiceUnit] = useState<'piece' | 'metre' | 'sqm'>('piece');
  const [newServicePrice, setNewServicePrice] = useState('');

  const [newMaterialName, setNewMaterialName] = useState('');
  const [newMaterialPrice, setNewMaterialPrice] = useState('');

  const [newClientName, setNewClientName] = useState('');
  const [newClientCreditDays, setNewClientCreditDays] = useState('');

  const [maxDiscountPct, setMaxDiscountPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discountValue = maxDiscountPct ?? String(catalog.maxDiscountPct);

  async function addStaff() {
    if (!newStaffName.trim() || !/^\d{4}$/.test(newStaffPin)) return setError('Name and a 4-digit PIN are required');
    setError(null);
    try {
      await api.post('/master-data/staff', { name: newStaffName, role: newStaffRole, pin: newStaffPin });
      setNewStaffName('');
      setNewStaffPin('');
      setNewStaffRole('Staff');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add staff member');
    }
  }

  async function addService() {
    const price = Number(newServicePrice);
    if (!newServiceName.trim() || !price) return setError('Service name and price are required');
    setError(null);
    try {
      await api.post('/master-data/services', { name: newServiceName, unit: newServiceUnit, price });
      setNewServiceName('');
      setNewServicePrice('');
      setNewServiceUnit('piece');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add service');
    }
  }

  async function addMaterial() {
    const price = Number(newMaterialPrice);
    if (!newMaterialName.trim() || !price) return setError('Material name and price are required');
    setError(null);
    try {
      await api.post('/master-data/materials', { name: newMaterialName, price });
      setNewMaterialName('');
      setNewMaterialPrice('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add material');
    }
  }

  async function addClient() {
    const days = Number(newClientCreditDays) || 30;
    if (!newClientName.trim()) return setError('Client name is required');
    setError(null);
    try {
      await api.post('/master-data/corporate-clients', { name: newClientName, creditDays: days });
      setNewClientName('');
      setNewClientCreditDays('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add corporate client');
    }
  }

  async function saveDiscountCeiling() {
    setError(null);
    try {
      await api.put('/master-data/settings', { maxDiscountPct: Number(discountValue) || 0 });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update discount rule');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={'btn blueprint ' + (tab === id ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab(id)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}

      {tab === 'staff' && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {catalog.staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span className="tag tag-neutral">{s.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 760 }}>
            <div className="field">
              <label>New staff name</label>
              <input className="input" value={newStaffName} onChange={(e) => setNewStaffName(e.target.value)} />
            </div>
            <div className="field">
              <label>Role</label>
              <select className="input" value={newStaffRole} onChange={(e) => setNewStaffRole(e.target.value as typeof newStaffRole)}>
                <option value="Staff">Staff</option>
                <option value="Supervisor">Supervisor</option>
                <option value="Admin">Admin</option>
              </select>
            </div>
            <div className="field">
              <label>4-digit PIN</label>
              <input className="input" value={newStaffPin} maxLength={4} onChange={(e) => setNewStaffPin(e.target.value.replace(/\D/g, ''))} />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addStaff}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add
            </button>
          </div>
        </>
      )}

      {tab === 'services' && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Unit</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {catalog.services.map((sv) => (
                <tr key={sv.id}>
                  <td>{sv.name}</td>
                  <td className="text-muted">{sv.unit}</td>
                  <td>{fmtKsh(sv.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 760 }}>
            <div className="field">
              <label>New service</label>
              <input className="input" value={newServiceName} onChange={(e) => setNewServiceName(e.target.value)} />
            </div>
            <div className="field">
              <label>Unit</label>
              <select className="input" value={newServiceUnit} onChange={(e) => setNewServiceUnit(e.target.value as typeof newServiceUnit)}>
                <option value="piece">piece</option>
                <option value="metre">metre</option>
                <option value="sqm">sqm</option>
              </select>
            </div>
            <div className="field">
              <label>Price (Ksh)</label>
              <input className="input" value={newServicePrice} onChange={(e) => setNewServicePrice(e.target.value)} />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addService}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add
            </button>
          </div>
        </>
      )}

      {tab === 'materials' && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {catalog.materials.map((mt) => (
                <tr key={mt.id}>
                  <td>{mt.name}</td>
                  <td>{fmtKsh(mt.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 640 }}>
            <div className="field">
              <label>New material</label>
              <input className="input" value={newMaterialName} onChange={(e) => setNewMaterialName(e.target.value)} />
            </div>
            <div className="field">
              <label>Price (Ksh)</label>
              <input className="input" value={newMaterialPrice} onChange={(e) => setNewMaterialPrice(e.target.value)} />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addMaterial}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add
            </button>
          </div>
        </>
      )}

      {tab === 'clients' && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Corporate client</th>
                <th>Credit terms</th>
              </tr>
            </thead>
            <tbody>
              {catalog.corporateClients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="text-muted">{c.creditDays} days</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 640 }}>
            <div className="field">
              <label>New corporate client</label>
              <input className="input" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} />
            </div>
            <div className="field">
              <label>Credit terms (days)</label>
              <input className="input" value={newClientCreditDays} onChange={(e) => setNewClientCreditDays(e.target.value)} />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addClient}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add
            </button>
          </div>
        </>
      )}

      {tab === 'discount' && (
        <>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Standard discount ceiling (%) before supervisor approval is flagged</label>
            <input className="input" value={discountValue} onChange={(e) => setMaxDiscountPct(e.target.value)} onBlur={saveDiscountCeiling} />
          </div>
          <p className="note">Applies to both walk-in and corporate line/order discounts. Staff can still submit above this — it only raises the approval flag.</p>
        </>
      )}
    </div>
  );
}
