import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';

const TABS_BY_ROLE: Record<string, [string, string][]> = {
  Staff: [
    ['/orders/new/walkin', 'New Walk-in Order'],
    ['/orders/new/quote', 'New Quotation'],
    ['/orders/mine', 'My Orders'],
  ],
  // P&L/Finance moved off Supervisor to the dedicated finance roles below;
  // Supervisor keeps order/payment oversight and can still raise (but not
  // approve) stock requisitions.
  Supervisor: [
    ['/orders/all', 'All Orders'],
    ['/payments', 'Payments'],
    ['/stock', 'Stock'],
    ['/film', 'Film'],
  ],
  'Finance Manager': [
    ['/orders/all', 'All Orders'],
    ['/payments', 'Payments'],
    ['/pnl', 'P&L'],
    ['/finance', 'Finance'],
    ['/stock', 'Stock'],
    ['/film', 'Film'],
  ],
  'General Manager': [
    ['/orders/all', 'All Orders'],
    ['/payments', 'Payments'],
    ['/pnl', 'P&L'],
    ['/finance', 'Finance'],
    ['/stock', 'Stock'],
    ['/film', 'Film'],
  ],
  Admin: [
    ['/orders/all', 'All Orders'],
    ['/payments', 'Payments'],
    ['/master-data', 'Master Data'],
    ['/pnl', 'P&L'],
    ['/finance', 'Finance'],
    ['/stock', 'Stock'],
    ['/film', 'Film'],
  ],
};

export default function AppLayout() {
  const { user, logout } = useAuth();
  const tabs = user ? TABS_BY_ROLE[user.role] ?? [] : [];

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
