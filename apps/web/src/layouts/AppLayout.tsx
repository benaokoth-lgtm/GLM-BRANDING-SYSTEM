import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import ChangePinDialog from '../components/ChangePinDialog';
import { useTheme, type Theme } from '../hooks/useTheme';
import Icon from '../components/NavIcons';
import type { CurrentUser } from '../state/AuthContext';
import { useApprovalsBadge } from '../hooks/useApprovals';
import { priceListsFor } from '@glm/shared';

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

  // Approvals: the inbox of everything waiting for a decision, and how your own requests went — for everyone signed in.
  tabs.push(['/approvals', 'Approvals']);
  // The sales screens, once under each price list: GLM Sales (our own staff, GLM prices) and Freelancer Sales (sales persons, freelancer prices). A person sees the lists their role may capture under:
  // a sales person only Freelancer Sales, the front office and managers both, GLM's own staff GLM Sales.
  const salesScreens = (prefix: string) => {
    if (isAdmin || p.canCaptureOrders) tabs.push([prefix + '/orders/new/walkin', 'General Order']);
    if (isAdmin || p.canAccessDtf || p.canManageDtf) {
      tabs.push([prefix + '/orders/new/film', 'DTF Film Order'], [prefix + '/orders/new/artwork', 'DTF Artwork Order'], [prefix + '/orders/new/uv-film', 'UV DTF Film Order'], [prefix + '/orders/new/uv-artwork', 'UV DTF Artwork Order']);
    }
    // Embroidery is taken like a General Order (anyone who captures orders), priced by stitch count.
    if (isAdmin || p.canCaptureOrders) tabs.push([prefix + '/orders/new/embroidery', 'Embroidery Order']);
    // Costing an outsourced branding job (business cards, signage) from the supplier rates under Job Costing → Rates, to quote a price.
    if (isAdmin || p.canCaptureOrders || p.canAccessFinance) tabs.push([prefix + '/costing', 'Job Costing']);
  };
  const lists = priceListsFor(user.role, p);
  if (lists.includes('glm')) salesScreens('');
  if (lists.includes('freelancer')) salesScreens('/freelancer');
  if (isAdmin || p.canViewAllOrders) tabs.push(['/orders/all', 'All Orders']);
  else if (p.canCaptureOrders) tabs.push(['/orders/all', 'Orders']);
  // Commission on sales: everyone who captures orders sees their own; people who manage it see the whole team. Only while an Admin has
  // switched the scheme on (Master Data → Company Info).
  // The staff Client Register (each sales person's clients, picked on the order screens) is a part of Commission, so the front office, who capture for others, see Commission for that.
  if (commissionOn && (isAdmin || p.canCaptureOrders || p.canManageCommission || p.canCaptureForOthers)) tabs.push(['/commission', 'Commission']);
  // Once captured, orders are managed in Production and then inspected in Quality Control.
  if (isAdmin || p.canAccessProduction || p.canManageProduction) tabs.push(['/production', 'Production']);
  if (isAdmin || p.canAccessQuality) tabs.push(['/quality', 'Quality Control']);
  if (!hasFinance && (isAdmin || p.canManagePayments)) tabs.push(['/payments', 'Payments']);
  // The petty cash desk: someone who logs petty cash without Finance access (the front office) gets just that, as its own entry (Finance has it as a tab).
  if (!hasFinance && p.canCapturePettyCash) tabs.push(['/petty-cash', 'Petty Cash']);
  if (isAdmin) tabs.push(['/master-data', 'Master Data']);
  if (hasFinance) tabs.push(['/finance', 'Finance'], ['/compliance', 'Compliance']);
  // Accounting (books, statements, notes, M-Pesa matching). Someone who can manage payments but isn't in Accounting
  // still gets M-Pesa matching, as its own entry.
  if (isAdmin || p.canAccessAccounting) tabs.push(['/accounting', 'Accounting']);
  else if (p.canManagePayments || p.canAccessPnl) tabs.push(['/accounting', p.canAccessPnl && p.canManagePayments ? 'P&L & M-Pesa' : p.canAccessPnl ? 'P&L' : 'M-Pesa Matching']);
  if (isAdmin || p.canAccessReports) tabs.push(['/reports', 'Reports']);
  if (isAdmin || p.canAccessStock) tabs.push(['/stock', 'Stock']);
  if (isAdmin || p.canManageDtf) tabs.push(['/dtf', 'DTF']);
  // People (HR): leave, the off-day calendar and reviews. Everyone with HR access asks for their own leave.
  if (isAdmin || p.canAccessHr || p.canManageHr) tabs.push(['/hr', 'People (HR)']);

  return tabs;
}

import { useBranding } from '../hooks/useBranding';
import { SubNavProvider, useSubNav } from '../state/SubNavContext';
import { useFeatures } from '../hooks/useFeatures';

// The sidebar, in one column: the signed-in person at the top (their menu has Change PIN and Log out), the modules in labelled groups, and the everyday
// utilities (colour scheme, collapse) at the bottom. Only the modules a person's role allows are listed, so a group with nothing in it does not appear.
type Group = 'sales' | 'glm' | 'freelancer' | 'operations' | 'finance' | 'admin';
const GROUPS: [Group, string][] = [
  ['sales', 'Sales'],
  ['glm', 'GLM Sales'],
  ['freelancer', 'Freelancer Sales'],
  ['operations', 'Operations'],
  ['finance', 'Finance'],
  ['admin', 'Admin'],
];
const GROUP_OF: Record<string, Group> = {
  '/approvals': 'sales',
  '/orders/new/walkin': 'glm',
  '/orders/new/film': 'glm',
  '/orders/new/artwork': 'glm',
  '/orders/new/uv-film': 'glm',
  '/orders/new/uv-artwork': 'glm',
  '/orders/new/embroidery': 'glm',
  '/costing': 'glm',
  '/orders/all': 'sales',
  '/commission': 'sales',
  '/production': 'operations',
  '/quality': 'operations',
  '/stock': 'operations',
  '/dtf': 'operations',
  '/hr': 'operations',
  '/finance': 'finance',
  '/compliance': 'finance',
  '/accounting': 'finance',
  '/payments': 'finance',
  '/petty-cash': 'finance',
  '/reports': 'finance',
  '/master-data': 'admin',
};
const ICON_OF: Record<string, string> = {
  '/approvals': 'approvals',
  '/orders/new/walkin': 'order',
  '/orders/new/film': 'film',
  '/orders/new/artwork': 'artwork',
  '/orders/new/uv-film': 'film',
  '/orders/new/uv-artwork': 'artwork',
  '/orders/new/embroidery': 'embroidery',
  '/costing': 'costing',
  '/orders/all': 'orders',
  '/commission': 'commission',
  '/production': 'production',
  '/quality': 'quality',
  '/stock': 'stock',
  '/dtf': 'dtf',
  '/hr': 'people',
  '/finance': 'finance',
  '/compliance': 'compliance',
  '/accounting': 'accounting',
  '/payments': 'payments',
  '/petty-cash': 'payments',
  '/reports': 'reports',
  '/master-data': 'masterdata',
};
// the Freelancer Sales screens are the same ones under /freelancer
const groupOf = (path: string): Group => (path.startsWith('/freelancer/') ? 'freelancer' : GROUP_OF[path] ?? 'sales');
const iconOf = (path: string): string => ICON_OF[path] ?? ICON_OF[path.replace(/^\/freelancer/, '')] ?? 'orders';
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
  const badge = useApprovalsBadge(!!user);
  // the number in the browser tab too, so it is seen from another window
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = badge.count > 0 ? `(${badge.count}) ${base}` : base;
  }, [badge.count]);
  useEffect(() => {
    if (!badge.notice) return;
    const t = window.setTimeout(badge.clearNotice, 8000);
    return () => window.clearTimeout(t);
  }, [badge.notice]);

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
        {/* 0 — the name on the system screens (Master Data → Company) */}
        {branding?.systemName && (
          <div className="side-brand" title={branding.systemName}>
            {branding.logoDataUrl && <img src={branding.logoDataUrl} alt="" />}
            <b>{branding.systemName}</b>
          </div>
        )}
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
                    <span className="icon-wrap"><Icon name={iconOf(path)} size={19} /></span>
                    <span>{text}</span>
                    {path === '/approvals' && badge.count > 0 && <b className="nav-badge" title={`${badge.waiting} waiting for your decision${badge.news ? `, ${badge.news} of your requests decided` : ''}`}>{badge.count}</b>}
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
          {/* a module opens the first time it is used; the menu stays put while it loads */}
          <Suspense fallback={<p className="note">Loading…</p>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      {badge.notice && (
        <div className="approvals-toast no-print" role="status">
          <span>{badge.notice}</span>
          <NavLink to="/approvals" className="btn btn-primary btn-sm" onClick={badge.clearNotice}>Open Approvals</NavLink>
          <button type="button" className="btn btn-ghost btn-sm" onClick={badge.clearNotice} aria-label="Dismiss">✕</button>
        </div>
      )}
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
