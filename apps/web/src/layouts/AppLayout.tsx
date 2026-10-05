import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import ChangePinDialog from '../components/ChangePinDialog';
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

function AppLayoutInner() {
  const branding = useBranding();
  const subNav = useSubNav();
  const [overModules, setOverModules] = useState(false);
  const { user, logout, clearMustChangePin } = useAuth();
  const [changingPin, setChangingPin] = useState(false);
  const features = useFeatures();
  const tabs = user ? buildTabs(user, !!features?.commission) : [];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav className="nav no-print" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <span className="nav-brand" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {branding?.logoDataUrl && <img src={branding.logoDataUrl} alt={branding.companyName} style={{ height: 40, maxWidth: 140, objectFit: 'contain' }} />}
          <span>{branding?.companyName ? `${branding.companyName} — ` : ''}Order &amp; POS</span>
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          {user && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {user.name} · {user.role}
            </span>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setChangingPin(true)}>
            Change PIN
          </button>
          <button type="button" className="btn btn-secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </nav>

      {/* The modules. While someone is working in one of a module's sub-items this row is dimmed — still visible and clickable, full strength
          under the mouse — and clicking a module brings it back and returns that module to its starting view. */}
      <div
        className="no-print"
        onMouseEnter={() => setOverModules(true)}
        onMouseLeave={() => setOverModules(false)}
        onFocus={() => setOverModules(true)}
        onBlur={() => setOverModules(false)}
        style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-4) var(--space-6) 0', flexWrap: 'wrap', opacity: subNav.dim && !overModules ? 0.5 : 1, transition: 'opacity 0.2s ease' }}
      >
        {tabs.map(([path, label]) => (
          <NavLink
            key={path}
            to={path}
            onClick={subNav.goHome}
            className={({ isActive }) => 'btn blueprint ' + (isActive ? 'btn-primary' : 'btn-secondary')}
          >
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {label}
          </NavLink>
        ))}
      </div>

      <main style={{ flex: 1, padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', maxWidth: 1280, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <Outlet />
      </main>
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
