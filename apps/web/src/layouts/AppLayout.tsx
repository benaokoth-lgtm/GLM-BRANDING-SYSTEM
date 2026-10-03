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
function buildTabs(user: CurrentUser): [string, string][] {
  const isAdmin = user.role === 'Admin';
  const p = user.permissions;
  const tabs: [string, string][] = [];
  // Finance now hosts Quotation, Invoice, All Orders, Payments and P&L as
  // its own tabs — anyone who can reach Finance sees those there instead of
  // as separate top-level nav entries. A role like Supervisor, which has
  // order/payment oversight but not Finance access, still gets All
  // Orders/Payments as their own entries so that access isn't lost.
  const hasFinance = isAdmin || p.canAccessFinance;

  if (isAdmin || p.canCaptureOrders) {
    tabs.push(['/orders/new/walkin', 'General Order']);
  }
  if (isAdmin || p.canAccessDtf || p.canManageDtf) {
    tabs.push(['/orders/new/film', 'Film Order'], ['/orders/new/artwork', 'Artwork Order']);
  }
  if (isAdmin || p.canCaptureOrders) {
    tabs.push(['/orders/mine', 'My Orders']);
  }
  // Commission on sales: everyone who captures orders sees their own; people who manage it see the whole team.
  if (isAdmin || p.canCaptureOrders || p.canManageCommission) tabs.push(['/commission', 'Commission']);
  // Once captured, orders are managed in Production and then inspected in Quality Control.
  if (isAdmin || p.canAccessProduction || p.canManageProduction) tabs.push(['/production', 'Production']);
  if (isAdmin || p.canAccessQuality) tabs.push(['/quality', 'Quality Control']);
  if (!hasFinance && (isAdmin || p.canViewAllOrders)) tabs.push(['/orders/all', 'All Orders']);
  if (!hasFinance && (isAdmin || p.canManagePayments)) tabs.push(['/payments', 'Payments']);
  if (isAdmin) tabs.push(['/master-data', 'Master Data']);
  if (!hasFinance && (isAdmin || p.canAccessPnl)) tabs.push(['/pnl', 'P&L']);
  if (hasFinance) tabs.push(['/finance', 'Finance'], ['/compliance', 'Compliance']);
  // Accounting (books, statements, notes, M-Pesa matching). Someone who can manage payments but isn't in Accounting
  // still gets M-Pesa matching, as its own entry.
  if (isAdmin || p.canAccessAccounting) tabs.push(['/accounting', 'Accounting']);
  else if (p.canManagePayments) tabs.push(['/accounting', 'M-Pesa Matching']);
  if (isAdmin || p.canAccessReports) tabs.push(['/reports', 'Reports']);
  if (isAdmin || p.canAccessStock) tabs.push(['/stock', 'Stock']);
  if (isAdmin || p.canManageDtf) tabs.push(['/dtf', 'DTF']);

  return tabs;
}

import { useBranding } from '../hooks/useBranding';

export default function AppLayout() {
  const branding = useBranding();
  const { user, logout, clearMustChangePin } = useAuth();
  const [changingPin, setChangingPin] = useState(false);
  const tabs = user ? buildTabs(user) : [];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav className="nav no-print" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <span className="nav-brand" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {branding?.logoDataUrl && <img src={branding.logoDataUrl} alt={branding.companyName} style={{ height: 40, maxWidth: 140, objectFit: 'contain' }} />}
          <span>{branding?.companyName || 'GLM Branding'} — Order &amp; POS</span>
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

      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-4) var(--space-6) 0', flexWrap: 'wrap' }}>
        {tabs.map(([path, label]) => (
          <NavLink
            key={path}
            to={path}
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
