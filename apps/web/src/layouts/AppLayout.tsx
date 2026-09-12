import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
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
    tabs.push(['/orders/new/walkin', 'New Walk-in Order'], ['/orders/mine', 'My Orders']);
  }
  if (!hasFinance && (isAdmin || p.canViewAllOrders)) tabs.push(['/orders/all', 'All Orders']);
  if (!hasFinance && (isAdmin || p.canManagePayments)) tabs.push(['/payments', 'Payments']);
  if (isAdmin) tabs.push(['/master-data', 'Master Data']);
  if (!hasFinance && (isAdmin || p.canAccessPnl)) tabs.push(['/pnl', 'P&L']);
  if (hasFinance) tabs.push(['/finance', 'Finance'], ['/compliance', 'Compliance']);
  if (isAdmin || p.canAccessReports) tabs.push(['/reports', 'Reports']);
  if (isAdmin || p.canAccessStock) tabs.push(['/stock', 'Stock']);
  if (isAdmin || p.canAccessFilm) tabs.push(['/film', 'Film']);

  return tabs;
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const tabs = user ? buildTabs(user) : [];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav className="nav no-print" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <span className="nav-brand">GLM Branding — Order &amp; POS</span>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          {user && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {user.name} · {user.role}
            </span>
          )}
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
    </div>
  );
}
