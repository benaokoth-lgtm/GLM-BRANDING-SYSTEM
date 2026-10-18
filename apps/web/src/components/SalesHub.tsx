import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import type { CurrentUser } from '../state/AuthContext';

// New Order: ONE place in the menu where the sales screens sit in a row of buttons across the top — General Order, DTF Film, DTF Artwork, UV DTF Film, UV DTF Artwork, Embroidery and Job Costing — and the
// one pressed opens below. There is one price list. Whose sale it is — GLM's own or a sales person's — is chosen on the order (the front office allocates it; a sales person who captures their own is the
// sales person). Each screen keeps its own address, so links and bookmarks work.

export interface SalesScreen {
  path: string;
  label: string;
}

/** The sales screens a person may use, in the order they are shown. */
export function salesScreensFor(user: CurrentUser): SalesScreen[] {
  const p = user.permissions;
  const admin = user.role === 'Admin';
  const out: SalesScreen[] = [];
  if (admin || p.canCaptureOrders) out.push({ path: '/orders/new/walkin', label: 'General Order' });
  if (admin || p.canAccessDtf || p.canManageDtf) {
    out.push({ path: '/orders/new/film', label: 'DTF Film Order' }, { path: '/orders/new/artwork', label: 'DTF Artwork Order' }, { path: '/orders/new/uv-film', label: 'UV DTF Film Order' }, { path: '/orders/new/uv-artwork', label: 'UV DTF Artwork Order' });
  }
  // Embroidery is taken like a General Order (anyone who captures orders), priced by stitch count.
  if (admin || p.canCaptureOrders) out.push({ path: '/orders/new/embroidery', label: 'Embroidery Order' });
  // Costing an outsourced branding job (business cards, signage) from the supplier rates under Job Costing → Rates, to quote a price.
  if (admin || p.canCaptureOrders || p.canAccessFinance) out.push({ path: '/costing', label: 'Job Costing' });
  return out;
}

export default function SalesHub() {
  const { user } = useAuth();
  if (!user) return null;
  const screens = salesScreensFor(user);
  return (
    <>
      {screens.length > 1 && (
        <div className="no-print" role="navigation" aria-label="Sales screens" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {screens.map((s) => (
            <NavLink key={s.path} to={s.path} end className={({ isActive }) => 'btn ' + (isActive ? 'btn-primary' : 'btn-secondary')}>
              {s.label}
            </NavLink>
          ))}
        </div>
      )}
      <Outlet />
    </>
  );
}
