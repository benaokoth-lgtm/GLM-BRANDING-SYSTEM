import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { PERMISSION_KEYS, fmtKsh, priceFromCost } from '@glm/shared';
import { Fragment } from 'react';
import type { PermissionKey, RoleRow } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';
import MpesaSettingsPanel from '../components/MpesaSettingsPanel';
import MailSettingsPanel from '../components/MailSettingsPanel';

type MasterTab = 'staff' | 'roles' | 'services' | 'heads' | 'materials' | 'clients' | 'discount' | 'company' | 'mpesa' | 'email';

const TABS: [MasterTab, string][] = [
  ['staff', 'Staff & Users'],
  ['roles', 'Roles & Access'],
  ['services', 'Service Price List'],
  ['heads', 'Business Heads'],
  ['materials', 'Stock Price List'],
  ['clients', 'Corporate Clients'],
  ['discount', 'Discount Rules'],
  ['company', 'Company Info'],
  ['mpesa', 'M-Pesa'],
  ['email', 'Email'],
];

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  canCaptureOrders: 'Capture orders',
  canViewAllOrders: 'View all orders',
  canManagePayments: 'Payments',
  canAccessPnl: 'P&L (Accounting → Profit & Loss)',
  canAccessFinance: 'Finance / Compliance',
  canAccessStock: 'Stock',
  canApproveStock: 'Approve stock',
  canAccessReports: 'Reports',
  canAccessDtf: 'DTF: record sales & jobs',
  canManageDtf: 'DTF: rolls, costs & profit',
  canAccessAccounting: 'Accounting',
  canSeeCosts: 'See supplier costs & mark-ups',
  canAccessProduction: 'Production: work assigned jobs',
  canManageProduction: 'Production: assign staff & productivity',
  canAccessQuality: 'Quality control: inspect orders',
  canReceiveStock: 'Stores: receive purchased goods',
  canManageCommission: 'Commission: rates, team statements & payouts',
};

import { useSubTab } from '../state/SubNavContext';
import { notifyBrandingChanged } from '../hooks/useBranding';
import CommissionSwitch from '../components/CommissionSwitch';
import BusinessHeadsPanel from '../components/BusinessHeadsPanel';
import type { BusinessHeadRow } from '../api/models';

const MAX_LOGO_BYTES = 1.5 * 1024 * 1024;

export default function MasterData() {
  const catalog = useCatalog();
  const [tab, setTab] = useSubTab<MasterTab>('staff');
  const [heads, setHeads] = useState<BusinessHeadRow[]>([]);
  const loadHeads = () => api.get<BusinessHeadRow[]>('/master-data/business-heads').then(setHeads).catch(() => setHeads([]));
  useEffect(() => {
    loadHeads();
  }, []);

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

  // A name is captured in three parts: first name and surname are compulsory, the middle name is optional.
  const [newFirst, setNewFirst] = useState('');
  const [newMiddle, setNewMiddle] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('Staff');
  const [newStaffPin, setNewStaffPin] = useState('');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffEmailPin, setNewStaffEmailPin] = useState(false);
  // Staff with their email, for emailing login PINs (Admin only).
  const [staffDetails, setStaffDetails] = useState<{ id: number; name: string; firstName: string; middleName: string; lastName: string; role: string; email: string | null; mustChangePin: boolean }[]>([]);
  const [emailDrafts, setEmailDrafts] = useState<Record<number, string>>({});
  // Someone's name being corrected: the three parts as typed so far.
  const [nameDrafts, setNameDrafts] = useState<Record<number, { first: string; middle: string; last: string }>>({});
  const [staffNotice, setStaffNotice] = useState<string | null>(null);
  const [staffBusy, setStaffBusy] = useState(false);

  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceUnit, setNewServiceUnit] = useState<'piece' | 'metre' | 'sqm'>('piece');
  const [newServicePrice, setNewServicePrice] = useState('');
  const [servicePriceDrafts, setServicePriceDrafts] = useState<Record<number, string>>({});

  const [newMaterialName, setNewMaterialName] = useState('');
  const [newMaterialPrice, setNewMaterialPrice] = useState('');
  const [reorderDrafts, setReorderDrafts] = useState<Record<number, string>>({});


  const [newClientName, setNewClientName] = useState('');
  const [newClientCreditDays, setNewClientCreditDays] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [clientDrafts, setClientDrafts] = useState<Record<number, { email?: string; phone?: string }>>({});

  const [maxDiscountPct, setMaxDiscountPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discountValue = maxDiscountPct ?? String(catalog.maxDiscountPct);

  const [companyName, setCompanyName] = useState<string | null>(null);
  const [legalName, setLegalName] = useState<string | null>(null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(null);
  const [companyPhone, setCompanyPhone] = useState<string | null>(null);
  const [companyPhone2, setCompanyPhone2] = useState<string | null>(null);
  const [companyWebsite, setCompanyWebsite] = useState<string | null>(null);
  const [companyFacebook, setCompanyFacebook] = useState<string | null>(null);
  const [companyTiktok, setCompanyTiktok] = useState<string | null>(null);
  const [companyKraPin, setCompanyKraPin] = useState<string | null>(null);
  const [companyEmail, setCompanyEmail] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null | undefined>(undefined);
  const [savingCompany, setSavingCompany] = useState(false);
  const [companySaved, setCompanySaved] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const companyNameValue = companyName ?? catalog.settings.companyName;
  const legalNameValue = legalName ?? catalog.settings.legalName;
  const companyAddressValue = companyAddress ?? catalog.settings.companyAddress;
  const companyPhoneValue = companyPhone ?? catalog.settings.companyPhone;
  const companyPhone2Value = companyPhone2 ?? catalog.settings.companyPhone2 ?? '';
  const companyWebsiteValue = companyWebsite ?? catalog.settings.website ?? '';
  const companyFacebookValue = companyFacebook ?? catalog.settings.facebook ?? '';
  const companyTiktokValue = companyTiktok ?? catalog.settings.tiktok ?? '';
  const companyKraPinValue = companyKraPin ?? catalog.settings.kraPin ?? '';
  const companyEmailValue = companyEmail ?? catalog.settings.companyEmail;
  const logoValue = logoDataUrl !== undefined ? logoDataUrl : catalog.settings.logoDataUrl;

  function loadStaffDetails() {
    api.get<typeof staffDetails>('/master-data/staff-details').then(setStaffDetails).catch(() => setStaffDetails([]));
  }
  useEffect(loadStaffDetails, []);

  async function saveStaffName(id: number) {
    const d = nameDrafts[id];
    if (!d) return;
    if (!d.first.trim()) return setError('First name is required');
    if (!d.last.trim()) return setError('Surname is required');
    setError(null);
    setStaffNotice(null);
    try {
      await api.put(`/master-data/staff/${id}/name`, { firstName: d.first, middleName: d.middle, lastName: d.last });
      setNameDrafts((x) => {
        const { [id]: _drop, ...rest } = x;
        return rest;
      });
      catalog.reload();
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the name');
    }
  }

  async function saveStaffEmail(id: number) {
    setError(null);
    setStaffNotice(null);
    try {
      await api.put(`/master-data/staff/${id}/email`, { email: emailDrafts[id] ?? '' });
      setEmailDrafts((d) => {
        const { [id]: _drop, ...rest } = d;
        return rest;
      });
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the email address');
    }
  }

  async function sendPin(id: number, name: string) {
    if (!window.confirm(`Give ${name} a new random PIN and email it to them? Their old PIN stops working, and they will choose their own the first time they sign in.`)) return;
    setError(null);
    setStaffNotice(null);
    setStaffBusy(true);
    try {
      const r = await api.post<{ sentTo: string }>(`/master-data/staff/${id}/send-pin`, {});
      setStaffNotice(`A new PIN was emailed to ${r.sentTo}`);
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to email the PIN');
    } finally {
      setStaffBusy(false);
    }
  }

  // Contracted-out services: a generic in-place edit of the outsourced fields.
  async function saveServiceFields(serviceId: number, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, patch);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the service');
    }
  }

  async function addStaff() {
    if (!newFirst.trim()) return setError('First name is required');
    if (!newLast.trim()) return setError('Surname is required');
    if (!/^\d{4}$/.test(newStaffPin)) return setError('A 4-digit PIN is required');
    setError(null);
    try {
      const r = await api.post<{ emailed?: { ok: boolean; error?: string } }>('/master-data/staff', { firstName: newFirst, middleName: newMiddle, lastName: newLast, role: newStaffRole, pin: newStaffPin, email: newStaffEmail.trim(), emailPin: newStaffEmailPin && !!newStaffEmail.trim() });
      setStaffNotice(r.emailed ? (r.emailed.ok ? `Added — their PIN was emailed to ${newStaffEmail.trim()}` : `Added, but the PIN email failed: ${r.emailed.error}`) : null);
      setNewFirst('');
      setNewMiddle('');
      setNewLast('');
      setNewStaffPin('');
      setNewStaffEmail('');
      setNewStaffEmailPin(false);
      setNewStaffRole('Staff');
      catalog.reload();
      loadStaffDetails();
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

  async function toggleUsesArtworkPricing(serviceId: number, usesArtworkPricing: boolean) {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { usesArtworkPricing });
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

  // The line of business a material is normally bought for — purchases of it are tagged to it by default.
  async function saveMaterialHead(materialId: number, value: string) {
    setError(null);
    try {
      await api.put(`/master-data/materials/${materialId}`, { businessHeadId: value ? Number(value) : null });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the material');
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
        legalName: legalNameValue.trim(),
        companyAddress: companyAddressValue,
        companyPhone: companyPhoneValue,
        companyPhone2: companyPhone2Value,
        website: companyWebsiteValue,
        facebook: companyFacebookValue,
        tiktok: companyTiktokValue,
        kraPin: companyKraPinValue.trim(),
        companyEmail: companyEmailValue,
        logoDataUrl: logoValue,
      });
      catalog.reload();
      notifyBrandingChanged();
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
          {staffNotice && (
            <p className="note" style={{ fontWeight: 700, borderLeft: '3px solid var(--color-accent)', paddingLeft: 'var(--space-2)' }}>
              {staffNotice}
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {catalog.staff.map((s) => {
                const d = staffDetails.find((x) => x.id === s.id);
                const editing = emailDrafts[s.id] !== undefined;
                return (
                  <tr key={s.id}>
                    <td>
                      {nameDrafts[s.id] ? (
                        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', alignItems: 'center' }}>
                          <input className="input" style={{ width: 130 }} value={nameDrafts[s.id]!.first} onChange={(e) => setNameDrafts((x) => ({ ...x, [s.id]: { ...x[s.id]!, first: e.target.value } }))} placeholder="First name *" autoFocus />
                          <input className="input" style={{ width: 130 }} value={nameDrafts[s.id]!.middle} onChange={(e) => setNameDrafts((x) => ({ ...x, [s.id]: { ...x[s.id]!, middle: e.target.value } }))} placeholder="Middle name" />
                          <input className="input" style={{ width: 130 }} value={nameDrafts[s.id]!.last} onChange={(e) => setNameDrafts((x) => ({ ...x, [s.id]: { ...x[s.id]!, last: e.target.value } }))} placeholder="Surname *" />
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => saveStaffName(s.id)}>
                            Save
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNameDrafts((x) => { const { [s.id]: _d, ...rest } = x; return rest; })}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          {s.name} {d && !d.lastName && <span className="tag tag-accent" title="Staff need a first name and a surname — add the surname">Surname needed</span>}{' '}
                          {d?.mustChangePin && <span className="tag tag-outline" title="They were emailed a PIN and have not chosen their own yet">PIN not changed yet</span>}{' '}
                          {d && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNameDrafts((x) => ({ ...x, [s.id]: { first: d.firstName, middle: d.middleName, last: d.lastName } }))}>
                              Edit name
                            </button>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <span className="tag tag-neutral">{s.role}</span>
                    </td>
                    <td>
                      {editing ? (
                        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                          <input className="input" type="email" style={{ minWidth: 220 }} value={emailDrafts[s.id]} onChange={(e) => setEmailDrafts((x) => ({ ...x, [s.id]: e.target.value }))} placeholder="name@example.com" autoFocus />
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => saveStaffEmail(s.id)}>
                            Save
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEmailDrafts((x) => { const { [s.id]: _d, ...rest } = x; return rest; })}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          {d?.email || <span className="text-muted">—</span>}{' '}
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEmailDrafts((x) => ({ ...x, [s.id]: d?.email ?? '' }))}>
                            {d?.email ? 'Change' : 'Add email'}
                          </button>
                        </>
                      )}
                    </td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={staffBusy || !d?.email} title={d?.email ? 'Give them a new random PIN and email it' : 'Add an email address first'} onClick={() => sendPin(s.id, s.name)}>
                        Email login PIN
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end' }}>
            <div className="field">
              <label>First name *</label>
              <input className="input" value={newFirst} onChange={(e) => setNewFirst(e.target.value)} />
            </div>
            <div className="field">
              <label>Middle name (optional)</label>
              <input className="input" value={newMiddle} onChange={(e) => setNewMiddle(e.target.value)} />
            </div>
            <div className="field">
              <label>Surname *</label>
              <input className="input" value={newLast} onChange={(e) => setNewLast(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.8fr 1.4fr auto', gap: 'var(--space-3)', marginTop: 'var(--space-3)', alignItems: 'end' }}>
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
            <div className="field">
              <label>Email (optional)</label>
              <input className="input" type="email" value={newStaffEmail} onChange={(e) => setNewStaffEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <button type="button" className="btn btn-primary blueprint" onClick={addStaff}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              Add
            </button>
          </div>
          <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
            <input type="checkbox" checked={newStaffEmailPin} disabled={!newStaffEmail.trim()} onChange={(e) => setNewStaffEmailPin(e.target.checked)} /> Email them this PIN now (they will be asked to choose their own at first sign-in — set up the mail account under the Email tab first)
          </label>
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
                <th>Business head</th>
                <th>Unit</th>
                <th>Price</th>
                <th>Artwork pricing</th>
                <th>Charges pressing fee</th>
                <th>Contracted out</th>
              </tr>
            </thead>
            <tbody>
              {catalog.services.map((sv) => (
                <Fragment key={sv.id}>
                <tr>
                  <td>{sv.name}</td>
                  <td>
                    <select className="input" style={{ width: 170 }} value={sv.businessHeadId ?? ''} onChange={(e) => saveServiceFields(sv.id, { businessHeadId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {heads.filter((h) => h.active || h.id === sv.businessHeadId).map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                  </td>
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
                      <input type="checkbox" checked={sv.usesArtworkPricing} onChange={(e) => toggleUsesArtworkPricing(sv.id, e.target.checked)} />
                      {sv.usesArtworkPricing && <span className="tag tag-accent">By artwork size</span>}
                    </label>
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sv.chargesPressingFee} onChange={(e) => toggleChargesPressingFee(sv.id, e.target.checked)} />
                      {sv.chargesPressingFee && <span className="tag tag-accent">Heat press</span>}
                    </label>
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sv.outsourced} onChange={(e) => saveServiceFields(sv.id, { outsourced: e.target.checked })} />
                      {sv.outsourced && <span className="tag tag-accent">Outsourced</span>}
                    </label>
                  </td>
                </tr>
                {sv.outsourced && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--color-surface)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr auto', gap: 'var(--space-3)', alignItems: 'end', padding: 'var(--space-2) 0' }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Supplier</label>
                          <input className="input" defaultValue={sv.supplierName} onBlur={(e) => e.target.value !== sv.supplierName && saveServiceFields(sv.id, { supplierName: e.target.value })} placeholder="Who prints it for us" />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Usual supplier price per {sv.unit} (VAT incl.)</label>
                          <input
                            className="input"
                            inputMode="decimal"
                            defaultValue={sv.defaultSupplierCost ?? ''}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if ((v || null) !== (sv.defaultSupplierCost ?? null)) saveServiceFields(sv.id, { defaultSupplierCost: v > 0 ? v : null });
                            }}
                            placeholder="paper + service, e.g. 40"
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Mark-up</label>
                          <select className="input" value={sv.markupType ?? 'percent'} onChange={(e) => saveServiceFields(sv.id, { markupType: e.target.value })}>
                            <option value="percent">Percentage (%)</option>
                            <option value="amount">Amount (Ksh per {sv.unit})</option>
                          </select>
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>{(sv.markupType ?? 'percent') === 'percent' ? 'Mark-up %' : 'Mark-up Ksh'}</label>
                          <input
                            className="input"
                            inputMode="decimal"
                            defaultValue={sv.markupValue ?? 0}
                            onBlur={(e) => Number(e.target.value) !== (sv.markupValue ?? 0) && saveServiceFields(sv.id, { markupValue: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </div>
                        {(() => {
                          const cost = sv.defaultSupplierCost ?? 0;
                          const suggested = cost > 0 ? priceFromCost(cost, sv.markupType ?? 'percent', sv.markupValue ?? 0) : 0;
                          return (
                            <button type="button" className="btn btn-secondary btn-sm" disabled={suggested <= 0 || suggested === sv.price} onClick={() => saveServiceFields(sv.id, { price: suggested })}>
                              {suggested > 0 ? `Set price to ${fmtKsh(suggested)}` : 'Set price from cost'}
                            </button>
                          );
                        })()}
                      </div>
                      <div className="note">
                        The supplier quotes one price that includes paper and the service, VAT included; the mark-up gives the selling price (also VAT included). These are defaults — the real quote is entered on each job. Only people with the "See supplier costs" permission can see the supplier price and mark-up.
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Unit and price are editable in place — a service flagged "Artwork pricing" with unit "sqm" (e.g. DTF
            Printing, Embroidery) shows an "Artwork size (sqm)" field on order line items instead of a flat
            per-piece price: price is computed from one artwork's area, at the Ksh/sqm rate set here. Services flagged "Charges pressing fee" show a staff-picked heat
            press fee (Ksh 20–50 per piece) added on top of the price — only for jobs where GLM prints and presses.
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
                <th>Business head</th>
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
                    <td>
                      <select className="input" style={{ width: 170 }} value={mt.businessHeadId ?? ''} onChange={(e) => saveMaterialHead(mt.id, e.target.value)}>
                        <option value="">—</option>
                        {heads.filter((h) => h.active || h.id === mt.businessHeadId).map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                          </option>
                        ))}
                      </select>
                    </td>
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
            The business head is the line of business a material is normally bought for — its purchases are tagged to it by default (you can change that on the purchase order). Stock on hand increases when the store manager receives a purchase order, or by a stock take under Stock. Reorder level is editable
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

      {tab === 'heads' && <BusinessHeadsPanel heads={heads} onChanged={() => { loadHeads(); catalog.reload(); }} />}

      {tab === 'discount' && (
        <>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Standard discount ceiling (%) before supervisor approval is flagged</label>
            <input className="input" value={discountValue} onChange={(e) => setMaxDiscountPct(e.target.value)} onBlur={saveDiscountCeiling} />
          </div>
          <p className="note">Applies to both walk-in and corporate line/order discounts. Staff can still submit above this — it only raises the approval flag.</p>
        </>
      )}

      {tab === 'mpesa' && <MpesaSettingsPanel />}

      {tab === 'email' && <MailSettingsPanel />}

      {tab === 'company' && (
        <>
          <CommissionSwitch />
          <p className="note" style={{ marginBottom: 'var(--space-4)' }}>
            Shown on printed invoices, quotations, and walk-in receipts.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-6)', maxWidth: 760 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div className="field">
                <label>Company name (trading name)</label>
                <input className="input" value={companyNameValue} onChange={(e) => setCompanyName(e.target.value)} />
              </div>
              <div className="field">
                <label>Registered/legal entity name</label>
                <input className="input" value={legalNameValue} onChange={(e) => setLegalName(e.target.value)} placeholder="e.g. GLM Group Limited" />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>
                  If different from the trading name above (e.g. the logo carries the registered company name),
                  printed invoices/quotations show it as a small "trading name of ..." line under the brand name —
                  leave blank to hide it.
                </p>
              </div>
              <div className="field">
                <label>Address</label>
                <textarea className="input" rows={3} value={companyAddressValue} onChange={(e) => setCompanyAddress(e.target.value)} />
              </div>
              <div className="field">
                <label>Phone (first number)</label>
                <input className="input" value={companyPhoneValue} onChange={(e) => setCompanyPhone(e.target.value)} placeholder="07xx xxx xxx" />
              </div>
              <div className="field">
                <label>Phone (second number)</label>
                <input className="input" value={companyPhone2Value} onChange={(e) => setCompanyPhone2(e.target.value)} placeholder="07xx xxx xxx" />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>Both numbers print on invoices, quotations and receipts.</p>
              </div>
              <div className="field">
                <label>Website</label>
                <input className="input" value={companyWebsiteValue} onChange={(e) => setCompanyWebsite(e.target.value)} placeholder="www.glmgroup.co.ke" />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>Prints on invoices, quotations and receipts.</p>
              </div>
              <div className="field">
                <label>Facebook page</label>
                <input className="input" value={companyFacebookValue} onChange={(e) => setCompanyFacebook(e.target.value)} placeholder="facebook.com/yourpage or the page name" />
              </div>
              <div className="field">
                <label>TikTok</label>
                <input className="input" value={companyTiktokValue} onChange={(e) => setCompanyTiktok(e.target.value)} placeholder="@yourhandle" />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>Facebook and TikTok print on invoices and quotations. Shown exactly as you type them; leave blank to hide.</p>
              </div>
              <div className="field">
                <label>KRA PIN</label>
                <input className="input" value={companyKraPinValue} onChange={(e) => setCompanyKraPin(e.target.value.toUpperCase())} placeholder="P051234567Z" maxLength={11} />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>The company's PIN — printed as the employer's PIN on the payroll and the P9.</p>
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
