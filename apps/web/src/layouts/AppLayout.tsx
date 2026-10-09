import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import ChangePinDialog from '../components/ChangePinDialog';
import { useTheme, type Theme } from '../hooks/useTheme';
import Icon from '../components/NavIcons';
import type { CurrentUser } from '../state/AuthContext';

// Built from the logged-in user's permissions rather than a hardcoded map
// keyed by role name — a custom role created in Master Data → Roles &
// Access shows exactly the nav entries its permissions unlock, with no code
// change needed. 'Admin' always sees everything (including Master Data,
// which stays a fixed role check, not a configurable permission — see
// RequireRole on that route in App.tsx).
function buildTabs(user: CurrentUser, commissionOn: boolean): [string, string][] {
  const isAdmin = user.role === 'Admin';
  const p = user.permissions;
  const tabs: [string, string][] = [];
  // Finance hosts Quotation, Invoice, Payments, Expenses, Petty Cash and the Asset Register as its own
  // tabs — anyone who can reach Finance sees those there instead of as separate top-level nav entries. A role like
  // Supervisor, which has payment oversight but not Finance access, still gets Payments as its own entry so that
  // access isn't lost. All Orders is its own module for anyone who may see every order.
  const hasFinance = isAdmin || p.canAccessFinance;

  if (isAdmin || p.canCaptureOrders) {
    tabs.push(['/orders/new/walkin', 'General Order']);
  }
  if (isAdmin || p.canAccessDtf || p.canManageDtf) {
    tabs.push(['/orders/new/film', 'Film Order'], ['/orders/new/artwork', 'Artwork Order']);
  }
  if (isAdmin || p.canViewAllOrders) tabs.push(['/orders/all', 'All Orders']);
  else if (p.canCaptureOrders) tabs.push(['/orders/all', 'Orders']);
  // Commission on sales: everyone who captures orders sees their own; people who manage it see the whole team. Only while an Admin has
  // switched the scheme on (Master Data → Company Info).
  if (commissionOn && (isAdmin || p.canCaptureOrders || p.canManageCommission)) tabs.push(['/commission', 'Commission']);
  // Once captured, orders are managed in Production and then inspected in Quality Control.
  if (isAdmin || p.canAccessProduction || p.canManageProduction) tabs.push(['/production', 'Production']);
  if (isAdmin || p.canAccessQuality) tabs.push(['/quality', 'Quality Control']);
  if (!hasFinance && (isAdmin || p.canManagePayments)) tabs.push(['/payments', 'Payments']);
  if (isAdmin) tabs.push(['/master-data', 'Master Data']);
  if (hasFinance) tabs.push(['/finance', 'Finance'], ['/compliance', 'Compliance']);
  // Accounting (books, statements, notes, M-Pesa matching). Someone who can manage payments but isn't in Accounting
  // still gets M-Pesa matching, as its own entry.
  if (isAdmin || p.canAccessAccounting) tabs.push(['/accounting', 'Accounting']);
  else if (p.canManagePayments || p.canAccessPnl) tabs.push(['/accounting', p.canAccessPnl && p.canManagePayments ? 'P&L & M-Pesa' : p.canAccessPnl ? 'P&L' : 'M-Pesa Matching']);
  if (isAdmin || p.canAccessReports) tabs.push(['/reports', 'Reports']);
  if (isAdmin || p.canAccessStock) tabs.push(['/stock', 'Stock']);
  if (isAdmin || p.canManageDtf) tabs.push(['/dtf', 'DTF']);

  return tabs;
}

import { useBranding } from '../hooks/useBranding';
import { SubNavProvider, useSubNav } from '../state/SubNavContext';
import { useFeatures } from '../hooks/useFeatures';

// The sidebar. A slim rail on the left holds the module groups (Sales, Operations, Money, Admin), the colour scheme, Change PIN and Log out; the panel beside it lists
// the modules of the chosen group. The group follows the page being worked on, and a click on another group's icon shows that group without leaving the page.
type Group = 'sales' | 'operations' | 'money' | 'admin';
const GROUPS: [Group, string][] = [
  ['sales', 'Sales'],
  ['operations', 'Operations'],
  ['money', 'Money'],
  ['admin', 'Admin'],
];
const GROUP_OF: Record<string, Group> = {
  '/orders/new/walkin': 'sales',
  '/orders/new/film': 'sales',
  '/orders/new/artwork': 'sales',
  '/orders/all': 'sales',
  '/commission': 'sales',
  '/production': 'operations',
  '/quality': 'operations',
  '/stock': 'operations',
  '/dtf': 'operations',
  '/finance': 'money',
  '/compliance': 'money',
  '/accounting': 'money',
  '/payments': 'money',
  '/reports': 'money',
  '/master-data': 'admin',
};
const ICON_OF: Record<string, string> = {
  '/orders/new/walkin': 'order',
  '/orders/new/film': 'film',
  '/orders/new/artwork': 'artwork',
  '/orders/all': 'orders',
  '/commission': 'commission',
  '/production': 'production',
  '/quality': 'quality',
  '/stock': 'stock',
  '/dtf': 'dtf',
  '/finance': 'finance',
  '/compliance': 'compliance',
  '/accounting': 'accounting',
  '/payments': 'payments',
  '/reports': 'reports',
  '/master-data': 'masterdata',
};
const groupOf = (path: string): Group => GROUP_OF[path] ?? 'sales';
const THEME_ICONS: [Theme, string, string][] = [
  ['organic', 'sun', 'Organic'],
  ['nocturne', 'moon', 'Nocturne'],
  ['ivory', 'ivory', 'Ivory'],
];

function AppLayoutInner() {
  const branding = useBranding();
  const subNav = useSubNav();
  const { user, logout, clearMustChangePin } = useAuth();
  const [changingPin, setChangingPin] = useState(false);
  const features = useFeatures();
  const { theme, choose } = useTheme();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false); // the drawer, on a narrow screen
  const tabs = user ? buildTabs(user, !!features?.commission) : [];

  // The group on show follows the page; clicking another group's icon shows that group until the page changes.
  const current = (tabs.find(([path]) => pathname === path || pathname.startsWith(path + '/')) ?? tabs[0])?.[0];
  const pageGroup = current ? groupOf(current) : 'sales';
  const [picked, setPicked] = useState<Group | null>(null);
  useEffect(() => {
    setPicked(null);
    setOpen(false);
  }, [pathname]);
  const shown = picked ?? pageGroup;
  const present = GROUPS.filter(([g]) => tabs.some(([path]) => groupOf(path) === g));
  const list = tabs.filter(([path]) => groupOf(path) === shown);
  const canCapture = !!user && (user.role === 'Admin' || user.permissions.canCaptureOrders);
  const initials = (branding?.companyName || branding?.systemName || 'GLM').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="shell">
      <div className={'scrim no-print' + (open ? ' open' : '')} onClick={() => setOpen(false)} />
      <aside className={'sidebar no-print' + (open ? ' open' : '')} aria-label="Main menu">
        <div className="rail">
          <div className="rail-mark" title={branding?.systemName ?? ''}>{initials}</div>
          {present.map(([g, label]) => (
            <button key={g} type="button" className={'rail-btn' + (g === shown ? ' active' : '')} title={label} aria-label={label} aria-pressed={g === shown} onClick={() => setPicked(g)}>
              <Icon name={g} size={20} />
            </button>
          ))}
          <div className="rail-spacer" />
          <button type="button" className="rail-btn" title="Change PIN" aria-label="Change PIN" onClick={() => setChangingPin(true)}>
            <Icon name="key" size={20} />
          </button>
          <div className="rail-themes" role="group" aria-label="Colour scheme">
            {THEME_ICONS.map(([id, icon, label]) => (
              <button key={id} type="button" className={'rail-btn' + (theme === id ? ' active' : '')} title={label + ' colours'} aria-label={label + ' colours'} aria-pressed={theme === id} onClick={() => choose(id)}>
                <Icon name={icon} size={16} />
              </button>
            ))}
          </div>
          <button type="button" className="rail-btn" title="Log out" aria-label="Log out" onClick={logout}>
            <Icon name="logout" size={20} />
          </button>
        </div>

        <div className="panel">
          {branding?.logoDataUrl && <img className="panel-logo" src={branding.logoDataUrl} alt={branding.companyName} />}
          <div className="panel-org" title={branding?.systemName ?? ''}>
            <span>{branding?.systemName || branding?.companyName || ''}</span>
            {canCapture && (
              <Link className="plus" to="/orders/new/walkin" title="New order" aria-label="New order" onClick={subNav.goHome}>
                <Icon name="plus" size={14} />
              </Link>
            )}
          </div>
          <div className="panel-title">{GROUPS.find(([g]) => g === shown)?.[1]}</div>
          {/* While someone is working in one of a module's sub-items, a click on the module here returns that module to its starting view. */}
          <nav className="panel-nav">
            {list.map(([path, label]) => (
              <NavLink key={path} to={path} onClick={subNav.goHome} className={({ isActive }) => 'panel-link' + (isActive ? ' active' : '')}>
                <Icon name={ICON_OF[path] ?? 'orders'} size={18} />
                {label}
              </NavLink>
            ))}
          </nav>
          {user && (
            <div className="panel-user">
              <div className="who">
                <b>{user.name}</b>
                <span className="text-muted">{user.role}</span>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChangingPin(true)}>
                <Icon name="key" size={14} /> Change PIN
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={logout}>
                <Icon name="logout" size={14} /> Log out
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="content">
        <div className="topbar no-print">
          <button type="button" className="btn btn-secondary btn-icon" aria-label="Open the menu" onClick={() => setOpen(true)}>
            <Icon name="menu" size={20} />
          </button>
          <strong style={{ fontFamily: 'var(--font-heading)' }}>{branding?.systemName ?? ''}</strong>
        </div>
        <main style={{ flex: 1, padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', maxWidth: 1280, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
          <Outlet />
        </main>
      </div>
      {(changingPin || user?.mustChangePin) && <ChangePinDialog forced={!!user?.mustChangePin} onClose={() => setChangingPin(false)} onChanged={clearMustChangePin} />}
    </div>
  );
}

export default function AppLayout() {
  return (
    <SubNavProvider>
      <AppLayoutInner />
    </SubNavProvider>
  );
}
