import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MATERIAL_UNITS, PERMISSION_KEYS, compareSizes, fmtKsh, isWeakPin, priceFromCost, requiredPinLength } from '@glm/shared';
import { Fragment } from 'react';
import type { PermissionKey, RoleRow } from '@glm/shared';
import { api } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';
import { useAuth } from '../state/AuthContext';
import MpesaSettingsPanel from '../components/MpesaSettingsPanel';
import NcbaSettingsPanel from '../components/NcbaSettingsPanel';
import EmbroiderySettingsPanel from '../components/EmbroiderySettingsPanel';
import MailSettingsPanel from '../components/MailSettingsPanel';
import WhatsappSettingsPanel from '../components/WhatsappSettingsPanel';
import ResetPinDialog from '../components/ResetPinDialog';
import StaffEditDialog from '../components/StaffEditDialog';
import BackupPanel from '../components/BackupPanel';
import SecurityPanel from '../components/SecurityPanel';
import PriceListExcel from '../components/PriceListExcel';

type MasterTab = 'staff' | 'roles' | 'services' | 'heads' | 'materials' | 'discount' | 'company' | 'mpesa' | 'ncba' | 'embroidery' | 'email' | 'whatsapp' | 'backup' | 'security';

const TABS: [MasterTab, string][] = [
  ['staff', 'Staff & Users'],
  ['roles', 'Roles & Access'],
  ['services', 'Service Price List'],
  ['heads', 'Business Heads'],
  ['materials', 'Stock Price List'],
  ['discount', 'Discount Rules'],
  ['company', 'Company Info'],
  ['mpesa', 'M-Pesa'],
  ['embroidery', 'Embroidery Pricing'],
  ['ncba', 'NCBA'],
  ['email', 'Email'],
  ['whatsapp', 'WhatsApp'],
  ['backup', 'Backup & Restore'],
  ['security', 'Security'],
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
  canCaptureForOthers: 'Front office: capture orders for sales persons and freelancers, and take the money',
  canBeAssignedOrders: 'Sales person: the front office can give orders to this role',
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
  const { user } = useAuth();
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
  // The price list, grouped by item with each item's sizes in order (S, M, L, XL …).
  // The service price list, a service's sizes together and in order.
  const serviceRows = [...catalog.services].sort((a, b) => (a.item || a.name).localeCompare(b.item || b.name) || compareSizes(a.size ?? '', b.size ?? ''));
  const materialRows = [...catalog.materials].sort((a, b) => (a.item || a.name).localeCompare(b.item || b.name) || compareSizes(a.size ?? '', b.size ?? ''));

  // A name is captured in three parts: first name and surname are compulsory, the middle name is optional.
  const [newFirst, setNewFirst] = useState('');
  const [newMiddle, setNewMiddle] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('Staff');
  const [newStaffPin, setNewStaffPin] = useState('');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffEmailPin, setNewStaffEmailPin] = useState(false);
  // Staff with their email, for emailing login PINs (Admin only).
  const [staffDetails, setStaffDetails] = useState<{ id: number; name: string; firstName: string; middleName: string; lastName: string; role: string; email: string | null; mustChangePin: boolean; active: boolean; orderTakingOff: boolean }[]>([]);
  const [emailDrafts, setEmailDrafts] = useState<Record<number, string>>({});
  // Someone's name being corrected: the three parts as typed so far.
  const [nameDrafts, setNameDrafts] = useState<Record<number, { first: string; middle: string; last: string }>>({});
  // Someone's role being changed: the role chosen so far.
  const [staffNotice, setStaffNotice] = useState<string | null>(null);
  // The person whose PIN is being reset (the dialog sets a new one: typed here, or made, and optionally emailed).
  // The person being edited (name, email, role, order taking) in one window.
  const [editing, setEditing] = useState<{ id: number } | null>(null);
  const [resetting, setResetting] = useState<{ id: number; name: string; email: string | null; role: string } | null>(null);
  const [staffBusy, setStaffBusy] = useState(false);

  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceDescription, setNewServiceDescription] = useState('');
  const [newServiceSize, setNewServiceSize] = useState('');
  const [newServiceUnit, setNewServiceUnit] = useState<'piece' | 'metre' | 'sqm'>('piece');
  const [newServicePrice, setNewServicePrice] = useState('');
  const [svcEdit, setSvcEdit] = useState<Record<number, { item: string; description: string; size: string; unit: 'piece' | 'metre' | 'sqm'; price: string }>>({});
  // "Edit prices": every unit and price in the service price list opens for editing at once, and one Save applies what was changed.
  const [bulkPrices, setBulkPrices] = useState<Record<number, { unit: 'piece' | 'metre' | 'sqm'; price: string }> | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [priceNotice, setPriceNotice] = useState<string | null>(null);

  // The stock price list: a new item with its sizes (each size its own price), and a line being edited in place.
  const [newMaterial, setNewMaterial] = useState({ item: '', description: '', unit: 'piece', businessHeadId: '' });
  const [newVariants, setNewVariants] = useState<{ size: string; price: string }[]>([{ size: '', price: '' }]);
  const [matEdit, setMatEdit] = useState<Record<number, { item: string; description: string; size: string; unit: string; price: string }>>({});
  const [reorderDrafts, setReorderDrafts] = useState<Record<number, string>>({});



  const [maxDiscountPct, setMaxDiscountPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discountValue = maxDiscountPct ?? String(catalog.maxDiscountPct);

  const [companyName, setCompanyName] = useState<string | null>(null);
  const [legalName, setLegalName] = useState<string | null>(null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(null);
  const [companySystemName, setCompanySystemName] = useState<string | null>(null);
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
  const companySystemNameValue = companySystemName ?? catalog.settings.systemName ?? '';
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

  async function setAllOrderTaking(on: boolean) {
    if (!window.confirm(on ? 'Let every sales person take orders again? They are signed out and sign in again.' : 'Switch off order taking for every sales person? They are signed out, and the front office captures all orders for them. Their other duties are unaffected.')) return;
    setError(null);
    setStaffNotice(null);
    try {
      const r = await api.put<{ changed: number }>('/master-data/staff-order-taking', { on });
      setStaffNotice(on ? `${r.changed} sales persons can take orders again.` : `Order taking is off for ${r.changed} sales persons; the front office captures for them.`);
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change order taking');
    }
  }

  async function setStaffActive(id: number, name: string, active: boolean) {
    const question = active ? `Let ${name} sign in again?` : `Switch off ${name}'s sign-in? They are signed out straight away and cannot sign in again. Their orders, payments and pay records stay on record.`;
    if (!window.confirm(question)) return;
    setError(null);
    setStaffNotice(null);
    try {
      await api.put(`/master-data/staff/${id}/active`, { active });
      setStaffNotice(active ? `${name} can sign in again.` : `${name}'s sign-in is switched off.`);
      catalog.reload();
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the sign-in');
    }
  }

  // Permanent. Only works for someone with no history; otherwise the API says why and to use Switch off.
  async function deleteStaff(id: number, name: string) {
    if (!window.confirm(`Permanently delete ${name}? This cannot be undone.\n\nOnly people with no orders, payments, payroll or other records can be deleted. For anyone who has worked in the system, use Switch off instead.`)) return;
    setError(null);
    setStaffNotice(null);
    try {
      await api.del(`/master-data/staff/${id}`);
      setStaffNotice(`${name} was deleted.`);
      catalog.reload();
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this person');
    }
  }

  async function sendPin(id: number, name: string) {
    if (!window.confirm(`Give ${name} a new random PIN and email it to them? Their old PIN stops working, and they will choose their own the first time they sign in.`)) return;
    setError(null);
    setStaffNotice(null);
    setStaffBusy(true);
    try {
      const r = await api.post<{ sentTo: string }>(`/master-data/staff/${id}/send-pin`, {});
      setStaffNotice(`A new PIN was emailed to ${r.sentTo}. If it does not arrive, ask them to check spam / junk and confirm the address.`);
      loadStaffDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to email the PIN');
    } finally {
      setStaffBusy(false);
    }
  }

  // Contracted-out services: a generic in-place edit of the outsourced fields.
  // Delete a service from the price list. One no order has used goes outright; one that has been sold is only retired (the orders that used it keep it).
  async function deleteService(serviceId: number, name: string) {
    if (!window.confirm(`Delete "${name}" from the price list?\n\nIf no order has ever used it, it is removed. If it has been sold, it is taken off the price list and the order screens but stays on the orders that used it.`)) return;
    setError(null);
    try {
      const r = await api.del<{ deleted: boolean; retired: boolean; orders: number }>(`/master-data/services/${serviceId}`);
      setPriceNotice(r.deleted ? `${name} was deleted` : `${name} was taken off the price list (${r.orders} order line${r.orders === 1 ? '' : 's'} keep it)`);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the service');
    }
  }

  async function saveServiceFields(serviceId: number, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, patch);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the service');
    }
  }

  // The Admin, and a role that handles money, costs, pay or the books, needs a 6-digit PIN; others at least 4.
  const newStaffPinNeeds = requiredPinLength(newStaffRole, roles.find((r) => r.name === newStaffRole)?.permissions);

  async function addStaff() {
    if (!newFirst.trim()) return setError('First name is required');
    if (!newLast.trim()) return setError('Surname is required');
    // A PIN is optional when an email address is given: the system makes one and emails it (they choose their own at first sign-in).
    const makePin = !newStaffPin && !!newStaffEmail.trim();
    if (!makePin) {
      if (!/^\d+$/.test(newStaffPin) || newStaffPin.length < newStaffPinNeeds || newStaffPin.length > 6) return setError(`A PIN of ${newStaffPinNeeds === 6 ? '6 digits' : '4 to 6 digits'} is required for this role — or leave it blank and enter an email address to have one made and emailed`);
      if (isWeakPin(newStaffPin)) return setError('That PIN is too easy to guess (like 1234 or 0000). Choose a less obvious one');
    }
    setError(null);
    try {
      const r = await api.post<{ emailed?: { ok: boolean; error?: string } }>('/master-data/staff', { firstName: newFirst, middleName: newMiddle, lastName: newLast, role: newStaffRole, pin: newStaffPin, email: newStaffEmail.trim(), emailPin: (newStaffEmailPin || makePin) && !!newStaffEmail.trim() });
      setStaffNotice(r.emailed ? (r.emailed.ok ? `Added — their PIN was emailed to ${newStaffEmail.trim()}. If it does not arrive, ask them to check spam / junk and confirm the address.` : `Added, but the PIN email failed: ${r.emailed.error} Use “Email login PIN” on their line to try again.`) : null);
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
      await api.post('/master-data/services', { name: newServiceName, description: newServiceDescription, size: newServiceSize, unit: newServiceUnit, price });
      setNewServiceName('');
      setNewServiceDescription('');
      setNewServiceSize('');
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

  function startBulkPrices() {
    setSvcEdit({});
    setBulkPrices(Object.fromEntries(serviceRows.map((sv) => [sv.id, { unit: sv.unit, price: String(sv.price) }])));
  }

  const bulkChanges = bulkPrices ? serviceRows.filter((sv) => bulkPrices[sv.id] && (bulkPrices[sv.id]!.unit !== sv.unit || Number(bulkPrices[sv.id]!.price) !== sv.price)) : [];

  async function saveBulkPrices() {
    if (!bulkPrices) return;
    const bad = bulkChanges.find((sv) => !(Number(bulkPrices[sv.id]!.price) > 0));
    if (bad) return setError(`The price of ${bad.item || bad.name} must be greater than 0`);
    setError(null);
    setBulkBusy(true);
    try {
      for (const sv of bulkChanges) await api.put(`/master-data/services/${sv.id}`, { unit: bulkPrices[sv.id]!.unit, price: Number(bulkPrices[sv.id]!.price) });
      setPriceNotice(`${bulkChanges.length} price${bulkChanges.length === 1 ? '' : 's'} saved`);
      setBulkPrices(null);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the prices');
      catalog.reload();
    } finally {
      setBulkBusy(false);
    }
  }

  async function saveServiceEdit(serviceId: number) {
    const d = svcEdit[serviceId];
    if (!d) return;
    const price = Number(d.price);
    if (!d.item.trim()) return setError('The service name is required');
    if (!(price > 0)) return setError('The price must be greater than 0');
    setError(null);
    try {
      await api.put(`/master-data/services/${serviceId}`, { item: d.item, description: d.description, size: d.size, unit: d.unit, price });
      setSvcEdit((x) => {
        const { [serviceId]: _drop, ...rest } = x;
        return rest;
      });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the service');
    }
  }

  async function addMaterial() {
    if (!newMaterial.item.trim()) return setError('Item name is required');
    const variants = newVariants.map((v) => ({ size: v.size.trim(), price: Number(v.price) }));
    if (variants.some((v) => !(v.price > 0))) return setError('Every size needs a price greater than 0');
    if (variants.length > 1 && variants.some((v) => !v.size)) return setError('Give every size a name (L, XL …), or keep a single row with no size');
    setError(null);
    try {
      await api.post('/master-data/materials', { item: newMaterial.item, description: newMaterial.description, unit: newMaterial.unit || 'piece', businessHeadId: newMaterial.businessHeadId ? Number(newMaterial.businessHeadId) : null, variants });
      setNewMaterial({ item: '', description: '', unit: 'piece', businessHeadId: '' });
      setNewVariants([{ size: '', price: '' }]);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item');
    }
  }

  // "+ size" beside an item: the add form, ready with that item's name, description and unit.
  function startAddSize(mt: { item?: string; name: string; description?: string; unit?: string }) {
    setNewMaterial({ item: mt.item || mt.name, description: mt.description ?? '', unit: mt.unit || 'piece', businessHeadId: '' });
    setNewVariants([{ size: '', price: '' }]);
    setTimeout(() => document.getElementById('material-add')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  async function saveMaterialEdit(materialId: number) {
    const d = matEdit[materialId];
    if (!d) return;
    const price = Number(d.price);
    if (!d.item.trim()) return setError('Item name is required');
    if (!(price > 0)) return setError('The price must be greater than 0');
    setError(null);
    try {
      await api.put(`/master-data/materials/${materialId}`, { item: d.item, description: d.description, size: d.size, unit: d.unit || 'piece', price });
      setMatEdit((x) => {
        const { [materialId]: _drop, ...rest } = x;
        return rest;
      });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the line');
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
    if (!companyNameValue.trim()) return setError('The company name is required');
    setError(null);
    setSavingCompany(true);
    setCompanySaved(false);
    try {
      await api.put('/master-data/settings', {
        companyName: companyNameValue.trim(),
        systemName: companySystemNameValue.trim(),
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
        <p className="note" style={{ color: 'var(--color-error)' }}>
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
                <th>Order taking</th>
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
                          {d && !d.active && <span className="tag tag-outline" style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }} title="Cannot sign in; their history stays on record">Switched off</span>}{' '}
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
                      {s.id === user?.id && (
                        <>
                          {' '}
                          <span className="text-muted" style={{ fontSize: 11 }} title="Another Admin changes your role">(you)</span>
                        </>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const rp = s.role === 'Admin' ? null : roles.find((r) => r.name === s.role)?.permissions;
                        if (rp?.canCaptureForOthers) return <span className="tag tag-accent" title="The front office always takes orders">Front office</span>;
                        // only sales persons (roles marked "can be assigned orders") have order taking to switch on or off
                        if (!rp || !rp.canBeAssignedOrders) return <span className="text-muted">—</span>;
                        return (
                          <>
                            <span className={'tag ' + (d?.orderTakingOff ? 'tag-outline' : 'tag-neutral')} style={d?.orderTakingOff ? { borderColor: 'var(--color-error)', color: 'var(--color-error)' } : undefined}>{d?.orderTakingOff ? 'Off' : 'On'}</span>{' '}
                          </>
                        );
                      })()}
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
                      {s.id !== user?.id && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" title="Set a new PIN for them (type one, or have one made)" onClick={() => setResetting({ id: s.id, name: s.name, email: d?.email ?? null, role: s.role })}>
                            Reset PIN
                          </button>{' '}
                        </>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" disabled={staffBusy || !d?.email} title={d?.email ? 'Give them a new random PIN and email it' : 'Add an email address first'} onClick={() => sendPin(s.id, s.name)}>
                        Email login PIN
                      </button>{' '}
                      {d && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" disabled={staffBusy} title="Change their name, email, role or order taking" onClick={() => setEditing({ id: s.id })}>
                            Edit
                          </button>{' '}
                        </>
                      )}
                      {d && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={staffBusy} onClick={() => setStaffActive(s.id, s.name, !d.active)}>
                          {d.active ? 'Switch off' : 'Switch on'}
                        </button>
                      )}
                      {d && s.id !== user?.id && (
                        <>
                          {' '}
                          <button type="button" className="btn btn-ghost btn-sm" disabled={staffBusy} style={{ color: 'var(--color-error)' }} title="Delete for good (only if they have no history)" onClick={() => deleteStaff(s.id, s.name)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {editing &&
            (() => {
              const d = staffDetails.find((x) => x.id === editing.id);
              if (!d) return null;
              return (
                <StaffEditDialog
                  person={d}
                  isSelf={d.id === user?.id}
                  roleNames={roleNames}
                  permissionsOf={(r) => roles.find((x) => x.name === r)?.permissions}
                  onClose={() => setEditing(null)}
                  onDone={(message) => {
                    setStaffNotice(message);
                    setEditing(null);
                    catalog.reload();
                    loadStaffDetails();
                  }}
                />
              );
            })()}
          {resetting && (
            <ResetPinDialog
              person={resetting}
              needs={requiredPinLength(resetting.role, roles.find((r) => r.name === resetting.role)?.permissions)}
              onClose={() => setResetting(null)}
              onDone={(message) => {
                setStaffNotice(message);
                setResetting(null);
                loadStaffDetails();
              }}
            />
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-3)' }}>
            <span className="note" style={{ margin: 0 }}>
              <b>Order taking</b> decides who may capture General, Film and Artwork orders. Switched off, a sales person keeps every other duty their role allows and the <b>front office</b> captures for them.
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAllOrderTaking(false)}>
              Switch off for all sales persons
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAllOrderTaking(true)}>
              Switch on for all
            </button>
          </div>
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
              <label>{newStaffPinNeeds === 6 ? '6-digit PIN' : 'PIN (4–6 digits)'}{newStaffEmail.trim() ? ' — optional' : ''}</label>
              <input className="input" value={newStaffPin} maxLength={6} onChange={(e) => setNewStaffPin(e.target.value.replace(/\D/g, ''))} placeholder={newStaffEmail.trim() ? 'blank = made and emailed' : ''} />
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
            <input type="checkbox" checked={newStaffEmailPin || (!newStaffPin && !!newStaffEmail.trim())} disabled={!newStaffEmail.trim() || !newStaffPin} onChange={(e) => setNewStaffEmailPin(e.target.checked)} /> Email them their login now{!newStaffPin && newStaffEmail.trim() ? ' (a PIN is made for them)' : ' with this PIN'} — they will be asked to choose their own at first sign-in (set up the mail account under the Email tab first)
          </label>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Roles beyond "Admin" are defined under Roles &amp; Access — add or amend one there before assigning it here. Use <b>Edit</b> on a person's row to move them to another role: they are signed out and sign in again to use it. You cannot change your own role.
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
          <PriceListExcel kind="services" onApplied={catalog.reload} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', margin: 'var(--space-3) 0' }}>
            {!bulkPrices ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setPriceNotice(null); startBulkPrices(); }}>
                Edit prices &amp; units
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={saveBulkPrices} disabled={bulkBusy || bulkChanges.length === 0}>
                  {bulkBusy ? 'Saving…' : `Save ${bulkChanges.length} change${bulkChanges.length === 1 ? '' : 's'}`}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBulkPrices(null)} disabled={bulkBusy}>
                  Cancel
                </button>
              </>
            )}
            {priceNotice && <span className="tag tag-accent">{priceNotice}</span>}
            <span className="note" style={{ margin: 0 }}>
              {bulkPrices ? 'Change any price or unit below, then save them all together. Changed lines are outlined.' : 'Change many prices at once, or use Edit at the end of a line to change one line (name, description, size, unit and price).'}
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Description</th>
                <th>Size</th>
                <th>Business head</th>
                <th>Unit</th>
                <th>Price</th>
                <th>Artwork pricing</th>
                <th>Charges pressing fee</th>
                <th>Contracted out</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {serviceRows.map((sv) => (
                <Fragment key={sv.id}>
                <tr>
                  <td>
                    {svcEdit[sv.id] ? (
                      <input className="input" style={{ width: 160 }} value={svcEdit[sv.id]!.item} title="Renames every size of this service" onChange={(e) => setSvcEdit((x) => ({ ...x, [sv.id]: { ...x[sv.id]!, item: e.target.value } }))} />
                    ) : (
                      <>
                        {sv.item || sv.name}{' '}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          title="Add another size of this service"
                          onClick={() => {
                            setNewServiceName(sv.item || sv.name);
                            setNewServiceDescription(sv.description ?? '');
                            setNewServiceSize('');
                            setNewServiceUnit(sv.unit);
                            setNewServicePrice('');
                            setTimeout(() => document.getElementById('service-add')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
                          }}
                        >
                          + size
                        </button>
                      </>
                    )}
                  </td>
                  <td>
                    {svcEdit[sv.id] ? <input className="input" style={{ width: 170 }} value={svcEdit[sv.id]!.description} onChange={(e) => setSvcEdit((x) => ({ ...x, [sv.id]: { ...x[sv.id]!, description: e.target.value } }))} /> : sv.description || <span className="text-muted">—</span>}
                  </td>
                  <td>
                    {svcEdit[sv.id] ? (
                      <input className="input" style={{ width: 90 }} value={svcEdit[sv.id]!.size} placeholder="A3, L …" disabled={sv.soldViaDtfModule} title={sv.soldViaDtfModule ? 'Sold through the DTF module — it keeps its name' : undefined} onChange={(e) => setSvcEdit((x) => ({ ...x, [sv.id]: { ...x[sv.id]!, size: e.target.value } }))} />
                    ) : (
                      sv.size || <span className="text-muted">—</span>
                    )}
                  </td>
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
                    {svcEdit[sv.id] ? (
                      <select className="input" style={{ width: 90 }} value={svcEdit[sv.id]!.unit} onChange={(e) => setSvcEdit((x) => ({ ...x, [sv.id]: { ...x[sv.id]!, unit: e.target.value as 'piece' | 'metre' | 'sqm' } }))}>
                        <option value="piece">piece</option>
                        <option value="metre">metre</option>
                        <option value="sqm">sqm</option>
                      </select>
                    ) : bulkPrices?.[sv.id] ? (
                      <select className="input" style={{ width: 90, ...(bulkPrices[sv.id]!.unit !== sv.unit ? { borderColor: 'var(--color-accent)', borderWidth: 2 } : {}) }} value={bulkPrices[sv.id]!.unit} onChange={(e) => setBulkPrices((x) => ({ ...x!, [sv.id]: { ...x![sv.id]!, unit: e.target.value as 'piece' | 'metre' | 'sqm' } }))}>
                        <option value="piece">piece</option>
                        <option value="metre">metre</option>
                        <option value="sqm">sqm</option>
                      </select>
                    ) : (
                      sv.unit
                    )}
                  </td>
                  <td>
                    {svcEdit[sv.id] ? (
                      <input className="input" style={{ width: 100 }} inputMode="decimal" value={svcEdit[sv.id]!.price} onChange={(e) => setSvcEdit((x) => ({ ...x, [sv.id]: { ...x[sv.id]!, price: e.target.value } }))} />
                    ) : bulkPrices?.[sv.id] ? (
                      <input className="input" style={{ width: 100, ...(Number(bulkPrices[sv.id]!.price) !== sv.price ? { borderColor: 'var(--color-accent)', borderWidth: 2 } : {}) }} inputMode="decimal" value={bulkPrices[sv.id]!.price} onChange={(e) => setBulkPrices((x) => ({ ...x!, [sv.id]: { ...x![sv.id]!, price: e.target.value } }))} aria-label={`Price of ${sv.item || sv.name}`} />
                    ) : (
                      <>
                        {fmtKsh(sv.price)}
                        <span className="text-muted" style={{ fontSize: 11 }}>
                          {' '}
                          /{sv.unit}
                        </span>
                      </>
                    )}
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
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {svcEdit[sv.id] ? (
                      <>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => saveServiceEdit(sv.id)}>
                          Save
                        </button>{' '}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSvcEdit((x) => { const { [sv.id]: _d, ...rest } = x; return rest; })}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!bulkPrices} title="Change this line's name, description, size, unit and price" onClick={() => setSvcEdit((x) => ({ ...x, [sv.id]: { item: sv.item || sv.name, description: sv.description ?? '', size: sv.size ?? '', unit: sv.unit, price: String(sv.price) } }))}>
                        Edit
                      </button>
                      {!sv.soldViaDtfModule && (
                        <>
                          {' '}
                          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--color-error)' }} disabled={!!bulkPrices} title="Delete this service from the price list" onClick={() => deleteService(sv.id, sv.item ? `${sv.item}${sv.size ? ' — ' + sv.size : ''}` : sv.name)}>
                            Delete
                          </button>
                        </>
                      )}
                      </>
                    )}
                  </td>
                </tr>
                {sv.outsourced && (
                  <tr>
                    <td colSpan={10} style={{ background: 'var(--color-surface)' }}>
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
            Press Edit on a line to change its name, description, size, unit and price (changing the name renames every size of that service). A service flagged "Artwork pricing" with unit "sqm" (e.g. DTF
            Printing, Embroidery) shows an "Artwork size (sqm)" field on order line items instead of a flat
            per-piece price: price is computed from one artwork's area, at the Ksh/sqm rate set here. Services flagged "Charges pressing fee" show a staff-picked heat
            press fee (Ksh 20–50 per piece) added on top of the price — only for jobs where we print and press ourselves.
          </p>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            A service that comes in sizes (a banner in A3 and A2) has one line per size, each with its own price; orders and invoices show it as “Banner — A3”. Type a size on a line, or press <b>+ size</b> beside a service to add another size of it.
          </p>
          <div id="service-add" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-4)', alignItems: 'end', maxWidth: 900 }}>
            <div className="field">
              <label>New service</label>
              <input className="input" value={newServiceName} onChange={(e) => setNewServiceName(e.target.value)} />
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input className="input" value={newServiceDescription} onChange={(e) => setNewServiceDescription(e.target.value)} />
            </div>
            <div className="field">
              <label>Size (optional)</label>
              <input className="input" value={newServiceSize} onChange={(e) => setNewServiceSize(e.target.value)} placeholder="A3, L …" />
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
          <p className="note" style={{ marginTop: 0 }}>
            The stock price list. An item that comes in sizes — a polo shirt in L and XL — has one line per size, each with its own price and its own stock; orders, purchases and stock show it as
            “Polo Shirt — L”. Add an item with all its sizes below, or press <b>+ size</b> beside an item to add another size to it.
          </p>
          <PriceListExcel kind="materials" onApplied={catalog.reload} />
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Description</th>
                <th>Size</th>
                <th>Unit</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th>Business head</th>
                <th style={{ textAlign: 'right' }}>Stock on hand</th>
                <th>Reorder level</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {materialRows.map((mt, i) => {
                const lowStock = mt.stockQty <= mt.reorderLevel;
                const itemName = mt.item || mt.name;
                const firstOfItem = i === 0 || (materialRows[i - 1]!.item || materialRows[i - 1]!.name) !== itemName;
                const draft = matEdit[mt.id];
                return (
                  <tr key={mt.id} style={firstOfItem && i > 0 ? { borderTop: '2px solid var(--color-divider)' } : undefined}>
                    <td>
                      {draft ? (
                        <input className="input" style={{ width: 150 }} value={draft.item} title="Renames every size of this item" onChange={(e) => setMatEdit((x) => ({ ...x, [mt.id]: { ...x[mt.id]!, item: e.target.value } }))} />
                      ) : firstOfItem ? (
                        <>
                          <strong>{itemName}</strong>{' '}
                          <button type="button" className="btn btn-ghost btn-sm" title="Add another size of this item" onClick={() => startAddSize(mt)}>
                            + size
                          </button>
                        </>
                      ) : (
                        <span className="text-muted">″</span>
                      )}
                    </td>
                    <td>
                      {draft ? <input className="input" style={{ width: 170 }} value={draft.description} onChange={(e) => setMatEdit((x) => ({ ...x, [mt.id]: { ...x[mt.id]!, description: e.target.value } }))} /> : mt.description || <span className="text-muted">—</span>}
                    </td>
                    <td>{draft ? <input className="input" style={{ width: 80 }} value={draft.size} placeholder="L, XL …" onChange={(e) => setMatEdit((x) => ({ ...x, [mt.id]: { ...x[mt.id]!, size: e.target.value } }))} /> : mt.size || <span className="text-muted">—</span>}</td>
                    <td>{draft ? <input className="input" style={{ width: 80 }} list="material-units" value={draft.unit} onChange={(e) => setMatEdit((x) => ({ ...x, [mt.id]: { ...x[mt.id]!, unit: e.target.value } }))} /> : mt.unit || 'piece'}</td>
                    <td style={{ textAlign: 'right' }}>{draft ? <input className="input" style={{ width: 90, textAlign: 'right' }} inputMode="decimal" value={draft.price} onChange={(e) => setMatEdit((x) => ({ ...x, [mt.id]: { ...x[mt.id]!, price: e.target.value } }))} /> : fmtKsh(mt.price)}</td>
                    <td>
                      <select className="input" style={{ width: 150 }} value={mt.businessHeadId ?? ''} onChange={(e) => saveMaterialHead(mt.id, e.target.value)}>
                        <option value="">—</option>
                        {heads.filter((h) => h.active || h.id === mt.businessHeadId).map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>{mt.stockQty}</td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 80 }}
                        value={reorderDrafts[mt.id] ?? String(mt.reorderLevel)}
                        onChange={(e) => setReorderDrafts((d) => ({ ...d, [mt.id]: e.target.value }))}
                        onBlur={(e) => saveReorderLevel(mt.id, e.target.value)}
                      />
                    </td>
                    <td>
                      {draft ? (
                        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => saveMaterialEdit(mt.id)}>
                            Save
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMatEdit((x) => { const { [mt.id]: _d, ...rest } = x; return rest; })}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMatEdit((x) => ({ ...x, [mt.id]: { item: itemName, description: mt.description ?? '', size: mt.size ?? '', unit: mt.unit || 'piece', price: String(mt.price) } }))}>
                            Edit
                          </button>{' '}
                          {lowStock && <span className="tag tag-accent">Reorder</span>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="material-units">
            {MATERIAL_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <p className="note" style={{ marginTop: 'var(--space-2)' }}>
            Edit changes a line's description, size, unit and price; changing the <i>item</i> name renames every size of it. The business head is the line of business a material is normally bought for — its
            purchases are tagged to it by default (you can change that on the purchase order). Stock on hand increases when the store manager receives a purchase order, or by a stock take under Stock.
            Items at or below their reorder level are flagged for reorder.
          </p>

          <div id="material-add" className="card blueprint" style={{ padding: 'var(--space-4)', marginTop: 'var(--space-4)', maxWidth: 820 }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
              Add an item with its sizes
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', alignItems: 'end' }}>
              <div className="field">
                <label>Item</label>
                <input className="input" value={newMaterial.item} onChange={(e) => setNewMaterial((m) => ({ ...m, item: e.target.value }))} placeholder="e.g. Polo Shirt" />
              </div>
              <div className="field">
                <label>Description (optional)</label>
                <input className="input" value={newMaterial.description} onChange={(e) => setNewMaterial((m) => ({ ...m, description: e.target.value }))} placeholder="e.g. Cotton, collared" />
              </div>
              <div className="field">
                <label>Unit</label>
                <input className="input" list="material-units" value={newMaterial.unit} onChange={(e) => setNewMaterial((m) => ({ ...m, unit: e.target.value }))} />
              </div>
              <div className="field">
                <label>Business head (optional)</label>
                <select className="input" value={newMaterial.businessHeadId} onChange={(e) => setNewMaterial((m) => ({ ...m, businessHeadId: e.target.value }))}>
                  <option value="">—</option>
                  {heads.filter((h) => h.active).map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 'var(--space-3)' }}>
              <label style={{ fontWeight: 700 }}>Sizes and prices</label>
              <p className="note" style={{ marginTop: 0 }}>
                One row per size, each with its own price (for example L → 1,200 and XL → 1,300). For an item with a single price and no sizes, leave Size blank on one row.
              </p>
              {newVariants.map((v, i) => (
                <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                  <input className="input" style={{ width: 120 }} value={v.size} placeholder="Size (L, XL …)" onChange={(e) => setNewVariants((rows) => rows.map((r, j) => (j === i ? { ...r, size: e.target.value } : r)))} />
                  <input className="input" style={{ width: 140 }} inputMode="decimal" value={v.price} placeholder="Price (Ksh)" onChange={(e) => setNewVariants((rows) => rows.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))} />
                  {newVariants.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove this size" onClick={() => setNewVariants((rows) => rows.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewVariants((rows) => [...rows, { size: '', price: rows[rows.length - 1]?.price ?? '' }])}>
                  + Add a size
                </button>
                <button type="button" className="btn btn-primary blueprint" onClick={addMaterial}>
                  <i className="corner tl"></i>
                  <i className="corner tr"></i>
                  <i className="corner bl"></i>
                  <i className="corner br"></i>
                  Add to price list
                </button>
              </div>
            </div>
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
      {tab === 'ncba' && <NcbaSettingsPanel />}
      {tab === 'embroidery' && <EmbroiderySettingsPanel />}

      {tab === 'email' && <MailSettingsPanel />}
      {tab === 'whatsapp' && <WhatsappSettingsPanel />}

      {tab === 'backup' && <BackupPanel />}

      {tab === 'security' && <SecurityPanel />}

      {tab === 'company' && (
        <>
          <CommissionSwitch />
          <p className="note" style={{ marginBottom: 'var(--space-4)' }}>
            Shown on printed invoices, quotations, and walk-in receipts.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-6)', maxWidth: 760 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div className="field">
                <label>Company name — on documents (trading name)</label>
                <input className="input" value={companyNameValue} onChange={(e) => setCompanyName(e.target.value)} />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>Printed on invoices, quotations, receipts, payroll and P9.</p>
              </div>
              <div className="field">
                <label>Name on the system screen</label>
                <input className="input" value={companySystemNameValue} onChange={(e) => setCompanySystemName(e.target.value)} placeholder={companyNameValue || 'same as the company name'} />
                <p className="note" style={{ marginTop: 'var(--space-1)' }}>Shown in the header, the browser tab and the sign-in screens, exactly as you type it (nothing is added to it). Leave blank to use the company name.</p>
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
