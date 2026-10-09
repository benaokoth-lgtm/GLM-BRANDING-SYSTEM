import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
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
  // Embroidery is taken like a General Order (anyone who captures orders), priced by stitch count.
  if (isAdmin || p.canCaptureOrders) tabs.push(['/orders/new/embroidery', 'Embroidery Order']);
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

// The sidebar, in one column: the signed-in person at the top (their menu has Change PIN and Log out), the modules in labelled groups, and the everyday
// utilities (colour scheme, collapse) at the bottom. Only the modules a person's role allows are listed, so a group with nothing in it does not appear.
type Group = 'sales' | 'operations' | 'finance' | 'admin';
const GROUPS: [Group, string][] = [
  ['sales', 'Sales'],
  ['operations', 'Operations'],
  ['finance', 'Finance'],
  ['admin', 'Admin'],
];
const GROUP_OF: Record<string, Group> = {
  '/orders/new/walkin': 'sales',
  '/orders/new/film': 'sales',
  '/orders/new/artwork': 'sales',
  '/orders/new/embroidery': 'sales',
  '/orders/all': 'sales',
  '/commission': 'sales',
  '/production': 'operations',
  '/quality': 'operations',
  '/stock': 'operations',
  '/dtf': 'operations',
  '/finance': 'finance',
  '/compliance': 'finance',
  '/accounting': 'finance',
  '/payments': 'finance',
  '/reports': 'finance',
  '/master-data': 'admin',
};
const ICON_OF: Record<string, string> = {
  '/orders/new/walkin': 'order',
  '/orders/new/film': 'film',
  '/orders/new/artwork': 'artwork',
  '/orders/new/embroidery': 'embroidery',
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
  ['industrial', 'production', 'Industrial'],
];
const COLLAPSE_KEY = 'glm_sidebar';

function AppLayoutInner() {
  const branding = useBranding();
  const subNav = useSubNav();
  const { user, logout, clearMustChangePin } = useAuth();
  const [changingPin, setChangingPin] = useState(false);
  const features = useFeatures();
  const { theme, choose } = useTheme();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false); // the drawer, on a narrow screen
  const [menu, setMenu] = useState(false); // the person's menu
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const tabs = user ? buildTabs(user, !!features?.commission) : [];

  useEffect(() => {
    setOpen(false);
    setMenu(false);
  }, [pathname]);
  // the person's menu closes when anything else is clicked
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.side-profile')) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* the choice just isn't remembered */
      }
      return !c;
    });
  }

  const initials = (user?.name ?? '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

  return (
    <div className="shell">
      <div className={'scrim no-print' + (open ? ' open' : '')} onClick={() => setOpen(false)} />
      <aside className={'sidebar no-print' + (open ? ' open' : '') + (collapsed ? ' collapsed' : '')} aria-label="Main menu">
        {/* 1 — who is signed in */}
        <div className="side-profile">
          <button type="button" className="profile-btn" aria-expanded={menu} title={user ? `${user.name} · ${user.role}` : ''} onClick={() => setMenu((m) => !m)}>
            <span className="avatar">{initials}</span>
            <span className="profile-text">
              <b>{user?.name}</b>
              <span>{user?.role}</span>
            </span>
            <span className="chev" style={{ display: 'grid', color: 'var(--color-text-muted)' }}>
              <Icon name="chevron" size={16} />
            </span>
          </button>
          {menu && (
            <div className="profile-menu" role="menu">
              <button type="button" role="menuitem" className="side-util" onClick={() => { setMenu(false); setChangingPin(true); }}>
                <span className="icon-wrap"><Icon name="key" size={18} /></span>
                <span>Change PIN</span>
              </button>
              <button type="button" role="menuitem" className="side-util" onClick={logout}>
                <span className="icon-wrap"><Icon name="logout" size={18} /></span>
                <span>Log out</span>
              </button>
            </div>
          )}
        </div>

        {/* 2, 3, 4 — the modules, grouped by area; the page being worked on is filled in */}
        <nav className="side-scroll">
          {GROUPS.map(([g, label]) => {
            const items = tabs.filter(([path]) => groupOf(path) === g);
            if (!items.length) return null;
            return (
              <div key={g} className="side-group">
                <div className="side-group-title">{label}</div>
                {items.map(([path, text]) => (
                  <NavLink key={path} to={path} title={text} onClick={subNav.goHome} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
                    <span className="icon-wrap"><Icon name={ICON_OF[path] ?? 'orders'} size={19} /></span>
                    <span>{text}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        {/* 5 — utilities */}
        <div className="side-foot">
          <div className="side-themes" role="group" aria-label="Colour scheme">
            <div className="label">
              <span className="icon-wrap"><Icon name="palette" size={19} /></span>
              <span>Colours</span>
            </div>
            {THEME_ICONS.map(([id, icon, label]) => (
              <button key={id} type="button" className={'theme-dot' + (theme === id ? ' active' : '')} title={label + ' colours'} aria-label={label + ' colours'} aria-pressed={theme === id} onClick={() => choose(id)}>
                <Icon name={icon} size={14} />
              </button>
            ))}
          </div>
          <button type="button" className="side-util side-collapse" title={collapsed ? 'Expand the menu' : 'Collapse the menu'} onClick={toggleCollapsed}>
            <span className="icon-wrap"><Icon name={collapsed ? 'expand' : 'collapse'} size={19} /></span>
            <span>Collapse</span>
          </button>
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
