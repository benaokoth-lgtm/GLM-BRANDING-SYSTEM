import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { PERMISSION_KEYS, fmtKsh } from '@glm/shared';
import type { PermissionKey, RoleRow } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';

type MasterTab = 'staff' | 'roles' | 'services' | 'materials' | 'artworkBands' | 'clients' | 'discount' | 'company';

const TABS: [MasterTab, string][] = [
  ['staff', 'Staff & Users'],
  ['roles', 'Roles & Access'],
  ['services', 'Service Price List'],
  ['materials', 'Stock Price List'],
  ['artworkBands', 'Artwork Size Bands'],
  ['clients', 'Corporate Clients'],
  ['discount', 'Discount Rules'],
  ['company', 'Company Info'],
];

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  canCaptureOrders: 'Capture orders',
  canViewAllOrders: 'View all orders',
  canManagePayments: 'Payments',
  canAccessPnl: 'P&L',
  canAccessFinance: 'Finance / Compliance',
  canAccessStock: 'Stock',
  canApproveStock: 'Approve stock',
  canAccessFilm: 'Film',
  canAccessReports: 'Reports',
};

const MAX_LOGO_BYTES = 1.5 * 1024 * 1024;

export default function MasterData() {
  const catalog = useCatalog();
  const [tab, setTab] = useState<MasterTab>('staff');

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [newRoleName, setNewRoleName] = useState('');
  const [roleNameDrafts, setRoleNameDrafts] = useState<Record<number, string>>({});

  function loadRoles() {
    setRolesLoading(true);
    api
      .get<RoleRow[]>('/master-data/roles')
      .then(setRoles)
      .finally(() => setRolesLoading(false));
  }

  useEffect(loadRoles, []);

  const roleNames = ['Admin', ...roles.map((r) => r.name)];

  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('Staff');
  const [newStaffPin, setNewStaffPin] = useState('');

  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceUnit, setNewServiceUnit] = useState<'piece' | 'metre' | 'sqm'>('piece');
  const [newServicePrice, setNewServicePrice] = useState('');
  const [servicePriceDrafts, setServicePriceDrafts] = useState<Record<number, string>>({});

  const [newMaterialName, setNewMaterialName] = useState('');
  const [newMaterialPrice, setNewMaterialPrice] = useState('');
  const [reorderDrafts, setReorderDrafts] = useState<Record<number, string>>({});

  const [newBandLabel, setNewBandLabel] = useState('');
  const [newBandLengthCm, setNewBandLengthCm] = useState('');
  const [newBandWidthCm, setNewBandWidthCm] = useState('');
  const [newBandPrice, setNewBandPrice] = useState('');

  const [newClientName, setNewClientName] = useState('');
  const [newClientCreditDays, setNewClientCreditDays] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [clientDrafts, setClientDrafts] = useState<Record<number, { email?: string; phone?: string }>>({});

  const [maxDiscountPct, setMaxDiscountPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discountValue = maxDiscountPct ?? String(catalog.maxDiscountPct);

  const [companyName, setCompanyName] = useState<string | null>(null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(null);
  const [companyPhone, setCompanyPhone] = useState<string | null>(null);
  const [companyEmail, setCompanyEmail] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null | undefined>(undefined);
  const [savingCompany, setSavingCompany] = useState(false);
  const [companySaved, setCompanySaved] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const companyNameValue = companyName ?? catalog.settings.companyName;
  const companyAddressValue = companyAddress ?? catalog.settings.companyAddress;
  const companyPhoneValue = companyPhone ?? catalog.settings.companyPhone;
  const companyEmailValue = companyEmail ?? catalog.settings.companyEmail;
  const logoValue = logoDataUrl !== undefined ? logoDataUrl : catalog.settings.logoDataUrl;

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

  async function addRole() {
    if (!newRoleName.trim()) return setError('Role name is required');
    setError(null);
    try {
      await api.post('/master-data/roles', { name: newRoleName.trim() });
      setNewRoleName('');
      loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add role');
    }
  }

  async function toggleRolePermission(role: RoleRow, key: PermissionKey, value: boolean) {
    setError(null);
    try {
      await api.put(`/master-data/roles/${role.id}`, { permissions: { [key]: value } });
      loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  async function renameRole(role: RoleRow, name: string) {
    if (!name.trim() || name.trim() === role.name) {
      setRoleNameDrafts((d) => {
        const next = { ...d };
        delete next[role.id];
        return next;
      });
      return;
    }
    setError(null);
    try {
      await api.put(`/master-data/roles/${role.id}`, { name: name.trim() });
      setRoleNameDrafts((d) => {
        const next = { ...d };
        delete next[role.id];
        return next;
      });
      loadRoles();
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename role');
    }
  }

  async function removeRole(id: number) {
    setError(null);
    try {
      await api.del(`/master-data/roles/${id}`);
      loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove role');
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

  async function toggleTracksFilm(serviceId: number, tracksFilm: boolean) {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { tracksFilm });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update service');
    }
  }

  async function toggleChargesPressingFee(serviceId: number, chargesPressingFee: boolean) {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { chargesPressingFee });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update service');
    }
  }

  async function saveServicePrice(serviceId: number, value: string) {
    const price = Number(value);
    if (!price || price <= 0) return;
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { price });
      setServicePriceDrafts((d) => {
        const next = { ...d };
        delete next[serviceId];
        return next;
      });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update service price');
    }
  }

  async function changeServiceUnit(serviceId: number, unit: 'piece' | 'metre' | 'sqm') {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { unit });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update service unit');
    }
  }

  async function addMaterial() {
    const price = Number(newMaterialPrice);
    if (!newMaterialName.trim() || !price) return setError('Item name and price are required');
    setError(null);
    try {
      await api.post('/master-data/materials', { name: newMaterialName, price });
      setNewMaterialName('');
      setNewMaterialPrice('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item');
    }
  }

  async function addBand() {
    const lengthCm = Number(newBandLengthCm);
    const widthCm = Number(newBandWidthCm);
    const price = Number(newBandPrice);
    if (!newBandLabel.trim() || !lengthCm || !widthCm || !price) return setError('Label, length, width and price are all required');
    setError(null);
    try {
      await api.post('/master-data/artwork-size-bands', { label: newBandLabel, lengthCm, widthCm, price });
      setNewBandLabel('');
      setNewBandLengthCm('');
      setNewBandWidthCm('');
      setNewBandPrice('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add artwork size band');
    }
  }

  async function removeBand(id: number) {
    setError(null);
    try {
      await api.del(`/master-data/artwork-size-bands/${id}`);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove artwork size band');
    }
  }

  async function saveReorderLevel(materialId: number, value: string) {
    const level = Number(value);
    if (Number.isNaN(level) || level < 0) return;
    try {
      await api.put(`/master-data/materials/${materialId}`, { reorderLevel: level });
      setReorderDrafts((d) => {
        const next = { ...d };
        delete next[materialId];
        return next;
      });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update reorder level');
    }
  }

  async function addClient() {
    const days = Number(newClientCreditDays) || 30;
    if (!newClientName.trim()) return setError('Client name is required');
    setError(null);
    try {
      await api.post('/master-data/corporate-clients', { name: newClientName, creditDays: days, email: newClientEmail, phone: newClientPhone });
      setNewClientName('');
      setNewClientCreditDays('');
      setNewClientEmail('');
      setNewClientPhone('');
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add corporate client');
    }
  }

  async function saveClientField(clientId: number, field: 'email' | 'phone', value: string) {
    setError(null);
    try {
      await api.put(`/master-data/corporate-clients/${clientId}`, { [field]: value });
      setClientDrafts((d) => ({ ...d, [clientId]: { ...d[clientId], [field]: undefined } }));
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update client');
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

  function handleLogoFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logo image must be under 1.5MB — resize it and try again');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result));
    reader.onerror = () => setError('Failed to read the selected image');
    reader.readAsDataURL(file);
  }

  async function saveCompanyInfo() {
    setError(null);
    setSavingCompany(true);
    setCompanySaved(false);
    try {
      await api.put('/master-data/settings', {
        companyName: companyNameValue.trim() || 'GLM Branding',
        companyAddress: companyAddressValue,
        companyPhone: companyPhoneValue,
        companyEmail: companyEmailValue,
        logoDataUrl: logoValue,
      });
      catalog.reload();
      setCompanySaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save company info');
    } finally {
      setSavingCompany(false);
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
              <select className="input" value={newStaffRole} onChange={(e) => setNewStaffRole(e.target.value)}>
                {roleNames.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
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
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Roles beyond "Admin" are defined under Roles &amp; Access — add or amend one there before assigning it here.
          </p>
        </>
      )}

      {tab === 'roles' && (
        <>
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            "Admin" always has full access to every area and isn't listed here — there's nothing to configure for it.
            Every other role is a row you can add, rename, or delete (once no staff member is still assigned to it),
            with a checkbox per area of the app it should be able to reach.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  {PERMISSION_KEYS.map((k) => (
                    <th key={k} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {PERMISSION_LABELS[k]}
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => {
                  const inUse = catalog.staff.some((s) => s.role === r.name);
                  return (
                    <tr key={r.id}>
                      <td>
                        <input
                          className="input"
                          style={{ minWidth: 140 }}
                          value={roleNameDrafts[r.id] ?? r.name}
                          onChange={(e) => setRoleNameDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                          onBlur={(e) => renameRole(r, e.target.value)}
                        />
                      </td>
                      {PERMISSION_KEYS.map((k) => (
                        <td key={k} style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={r.permissions[k]} onChange={(e) => toggleRolePermission(r, k, e.target.checked)} />
                        </td>
                      ))}
                      <td className="no-print">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          aria-label="Remove"
                          onClick={() => removeRole(r.id)}
                          disabled={inUse}
                          title={inUse ? 'Reassign every staff member off this role first' : undefined}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!rolesLoading && roles.length === 0 && <p className="note">No custom roles yet — add one below.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 480 }}>
            <div className="field">
              <label>New role name</label>
              <input className="input" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="e.g. Accountant" />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addRole}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add role
            </button>
          </div>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            A new role starts with only "Capture orders" checked — tick the boxes above to open up whatever else it
            needs.
          </p>
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
                <th>Tracks film</th>
                <th>Charges pressing fee</th>
              </tr>
            </thead>
            <tbody>
              {catalog.services.map((sv) => (
                <tr key={sv.id}>
                  <td>{sv.name}</td>
                  <td>
                    <select className="input" style={{ width: 90 }} value={sv.unit} onChange={(e) => changeServiceUnit(sv.id, e.target.value as 'piece' | 'metre' | 'sqm')}>
                      <option value="piece">piece</option>
                      <option value="metre">metre</option>
                      <option value="sqm">sqm</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="input"
                      style={{ width: 100 }}
                      value={servicePriceDrafts[sv.id] ?? String(sv.price)}
                      onChange={(e) => setServicePriceDrafts((d) => ({ ...d, [sv.id]: e.target.value }))}
                      onBlur={(e) => saveServicePrice(sv.id, e.target.value)}
                    />
                    <span className="text-muted" style={{ fontSize: 11 }}>
                      {' '}
                      /{sv.unit}
                    </span>
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sv.tracksFilm} onChange={(e) => toggleTracksFilm(sv.id, e.target.checked)} />
                      {sv.tracksFilm && <span className="tag tag-accent">DTF film</span>}
                    </label>
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sv.chargesPressingFee} onChange={(e) => toggleChargesPressingFee(sv.id, e.target.checked)} />
                      {sv.chargesPressingFee && <span className="tag tag-accent">Heat press</span>}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Unit and price are editable in place — a service flagged both "Tracks film" and unit "sqm" (e.g. DTF
            Printing) shows an "Artwork size (sqm)" field on order line items instead of a flat per-piece price:
            price and film used are computed from one artwork's area × quantity, at the Ksh/sqm rate set here.
            Services flagged "Tracks film" with unit "metre" (e.g. DTF Sheet) instead default Film used (m) to match
            Metres — a pure film sale, unaffected by pressing fees. Services flagged "Charges pressing fee" show a
            staff-picked heat press fee (Ksh 20–50 per piece) added on top of the price — only for jobs where GLM
            prints and presses.
          </p>
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
                <th>Item</th>
                <th>Price</th>
                <th>Stock on hand</th>
                <th>Reorder level</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {catalog.materials.map((mt) => {
                const lowStock = mt.stockQty <= mt.reorderLevel;
                return (
                  <tr key={mt.id}>
                    <td>{mt.name}</td>
                    <td>{fmtKsh(mt.price)}</td>
                    <td>{mt.stockQty}</td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 90 }}
                        value={reorderDrafts[mt.id] ?? String(mt.reorderLevel)}
                        onChange={(e) => setReorderDrafts((d) => ({ ...d, [mt.id]: e.target.value }))}
                        onBlur={(e) => saveReorderLevel(mt.id, e.target.value)}
                      />
                    </td>
                    <td>{lowStock && <span className="tag tag-accent">Reorder</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Stock on hand increases via approved requisitions or a stock take under Stock. Reorder level is editable
            here — items at or below it are flagged for reorder.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 640 }}>
            <div className="field">
              <label>New item</label>
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

      {tab === 'artworkBands' && (
        <>
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            Flat "quick pick" prices for common small DTF artwork sizes — an alternative to the area × Ksh/sqm
            formula, which underprices tiny prints dominated by fixed setup/press time rather than material. When
            staff capture an artwork's length × width, it's automatically matched to the smallest band it fits
            within (both length and width, either orientation) — a strict match, no rounding; anything too big for
            every band falls back to the normal formula. Film usage still deducts correctly off the matched band's
            area.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Size</th>
                <th>Length (cm)</th>
                <th>Width (cm)</th>
                <th>Area (sqm)</th>
                <th>Price (Ksh)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {catalog.artworkSizeBands.map((b) => (
                <tr key={b.id}>
                  <td>{b.label}</td>
                  <td className="text-muted">{b.lengthCm}</td>
                  <td className="text-muted">{b.widthCm}</td>
                  <td className="text-muted">{b.areaSqm}</td>
                  <td>{fmtKsh(b.price)}</td>
                  <td className="no-print">
                    <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => removeBand(b.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {catalog.artworkSizeBands.length === 0 && <p className="note">No artwork size bands yet — add one below.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.7fr 0.7fr 0.8fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 860 }}>
            <div className="field">
              <label>Size label</label>
              <input className="input" value={newBandLabel} onChange={(e) => setNewBandLabel(e.target.value)} placeholder="e.g. 6cm x 6cm" />
            </div>
            <div className="field">
              <label>Length (cm)</label>
              <input className="input" value={newBandLengthCm} onChange={(e) => setNewBandLengthCm(e.target.value)} placeholder="e.g. 6" />
            </div>
            <div className="field">
              <label>Width (cm)</label>
              <input className="input" value={newBandWidthCm} onChange={(e) => setNewBandWidthCm(e.target.value)} placeholder="e.g. 6" />
            </div>
            <div className="field">
              <label>Price (Ksh)</label>
              <input className="input" value={newBandPrice} onChange={(e) => setNewBandPrice(e.target.value)} placeholder="e.g. 50" />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addBand}>
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
                <th>Email</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {catalog.corporateClients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="text-muted">{c.creditDays} days</td>
                  <td>
                    <input
                      className="input"
                      style={{ minWidth: 160 }}
                      value={clientDrafts[c.id]?.email ?? c.email}
                      onChange={(e) => setClientDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], email: e.target.value } }))}
                      onBlur={(e) => saveClientField(c.id, 'email', e.target.value)}
                      placeholder="Optional"
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      style={{ minWidth: 140 }}
                      value={clientDrafts[c.id]?.phone ?? c.phone}
                      onChange={(e) => setClientDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], phone: e.target.value } }))}
                      onBlur={(e) => saveClientField(c.id, 'phone', e.target.value)}
                      placeholder="Optional"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Email and phone prefill the "Send email"/"Send WhatsApp" targets on that client's invoices and
            quotations.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.8fr 1fr 1fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 960 }}>
            <div className="field">
              <label>New corporate client</label>
              <input className="input" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} />
            </div>
            <div className="field">
              <label>Credit terms (days)</label>
              <input className="input" value={newClientCreditDays} onChange={(e) => setNewClientCreditDays(e.target.value)} />
            </div>
            <div className="field">
              <label>Email</label>
              <input className="input" value={newClientEmail} onChange={(e) => setNewClientEmail(e.target.value)} placeholder="Optional" />
            </div>
            <div className="field">
              <label>Phone</label>
              <input className="input" value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} placeholder="Optional" />
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

      {tab === 'company' && (
        <>
          <p className="note" style={{ marginBottom: 'var(--space-4)' }}>
            Shown on printed invoices, quotations, and walk-in receipts.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-6)', maxWidth: 760 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div className="field">
                <label>Company name</label>
                <input className="input" value={companyNameValue} onChange={(e) => setCompanyName(e.target.value)} />
              </div>
              <div className="field">
                <label>Address</label>
                <textarea className="input" rows={3} value={companyAddressValue} onChange={(e) => setCompanyAddress(e.target.value)} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input className="input" value={companyPhoneValue} onChange={(e) => setCompanyPhone(e.target.value)} placeholder="07xx xxx xxx" />
              </div>
              <div className="field">
                <label>Email</label>
                <input className="input" value={companyEmailValue} onChange={(e) => setCompanyEmail(e.target.value)} placeholder="hello@glmbranding.co.ke" />
              </div>
            </div>

            <div>
              <div className="field">
                <label>Logo</label>
                <div
                  className="card blueprint"
                  style={{ alignItems: 'center', justifyContent: 'center', minHeight: 140, padding: 'var(--space-4)' }}
                >
                  <i className="corner tl"></i>
                  <i className="corner tr"></i>
                  <i className="corner bl"></i>
                  <i className="corner br"></i>
                  {logoValue ? (
                    <img src={logoValue} alt="Company logo" style={{ maxHeight: 100, maxWidth: '100%', objectFit: 'contain' }} />
                  ) : (
                    <span className="note">No logo uploaded</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button type="button" className="btn btn-secondary blueprint" onClick={() => logoInputRef.current?.click()}>
                  <i className="corner tl"></i>
                  <i className="corner tr"></i>
                  <i className="corner bl"></i>
                  <i className="corner br"></i>
                  {logoValue ? 'Replace logo' : 'Upload logo'}
                </button>
                {logoValue && (
                  <button type="button" className="btn btn-ghost" onClick={() => setLogoDataUrl(null)}>
                    Remove
                  </button>
                )}
                <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoFile} />
              </div>
              <p className="note" style={{ marginTop: 'var(--space-2)' }}>
                PNG or JPG, under 1.5MB.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-4)' }}>
            <button type="button" className="btn btn-primary blueprint" onClick={saveCompanyInfo} disabled={savingCompany}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Save company info
            </button>
            {companySaved && <span className="tag tag-accent">Saved</span>}
          </div>
        </>
      )}
    </div>
  );
}
