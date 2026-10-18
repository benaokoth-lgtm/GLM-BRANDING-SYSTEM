import { NavLink, Outlet } from 'react-router-dom';
import { priceListsFor } from '@glm/shared';
import type { PriceList } from '@glm/shared';
import { useAuth } from '../state/AuthContext';
import type { CurrentUser } from '../state/AuthContext';
import { PriceListProvider } from '../state/PriceListContext';

// GLM Sales and Freelancer Sales, each as ONE place in the menu: the seven sales screens sit in a row of buttons across the top of it, and the one pressed opens below. Each screen keeps its own address
// (/orders/new/film, /freelancer/orders/new/film …), so links and bookmarks still work. A person sees the buttons their role allows, under the price lists their role may capture under.

export interface SalesScreen {
  path: string;
  label: string;
}

/** The sales screens a person may use under a price list, in the order they are shown. */
export function salesScreensFor(user: CurrentUser, list: PriceList): SalesScreen[] {
  const p = user.permissions;
  const admin = user.role === 'Admin';
  if (!priceListsFor(user.role, p).includes(list)) return [];
  const prefix = list === 'freelancer' ? '/freelancer' : '';
  const out: [string, string][] = [];
  if (admin || p.canCaptureOrders) out.push(['/orders/new/walkin', 'General Order']);
  if (admin || p.canAccessDtf || p.canManageDtf) out.push(['/orders/new/film', 'DTF Film Order'], ['/orders/new/artwork', 'DTF Artwork Order'], ['/orders/new/uv-film', 'UV DTF Film Order'], ['/orders/new/uv-artwork', 'UV DTF Artwork Order']);
  // Embroidery is taken like a General Order (anyone who captures orders), priced by stitch count.
  if (admin || p.canCaptureOrders) out.push(['/orders/new/embroidery', 'Embroidery Order']);
  // Costing an outsourced branding job (business cards, signage) from the supplier rates under Job Costing → Rates, to quote a price.
  if (admin || p.canCaptureOrders || p.canAccessFinance) out.push(['/costing', 'Job Costing']);
  return out.map(([path, label]) => ({ path: prefix + path, label }));
}

export default function SalesHub({ list }: { list: PriceList }) {
  const { user } = useAuth();
  if (!user) return null;
  const screens = salesScreensFor(user, list);
  return (
    <PriceListProvider list={list}>
      {screens.length > 1 && (
        <div className="no-print" role="navigation" aria-label={list === 'freelancer' ? 'Freelancer Sales screens' : 'GLM Sales screens'} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {screens.map((s) => (
            <NavLink key={s.path} to={s.path} end className={({ isActive }) => 'btn ' + (isActive ? 'btn-primary' : 'btn-secondary')}>
              {s.label}
            </NavLink>
          ))}
        </div>
      )}
      <Outlet />
    </PriceListProvider>
  );
}
