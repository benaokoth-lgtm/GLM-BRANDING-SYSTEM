import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/AuthContext';
import AppLayout from './layouts/AppLayout';
import RequireRole from './components/RequireRole';
import RequirePermission from './components/RequirePermission';
import Login from './pages/Login';
const Privacy = lazy(() => import('./pages/Privacy'));
const NewWalkinOrder = lazy(() => import('./pages/NewWalkinOrder'));
const NewFilmOrder = lazy(() => import('./pages/NewFilmOrder'));
const NewArtworkOrder = lazy(() => import('./pages/NewArtworkOrder'));
const Orders = lazy(() => import('./pages/Orders'));
const Payments = lazy(() => import('./pages/Payments'));
const MasterData = lazy(() => import('./pages/MasterData'));
const Finance = lazy(() => import('./pages/Finance'));
const PettyCashDesk = lazy(() => import('./pages/PettyCashDesk'));
const Hr = lazy(() => import('./pages/Hr'));
const Approvals = lazy(() => import('./pages/Approvals'));
const NewEmbroideryOrder = lazy(() => import('./pages/NewEmbroideryOrder'));
const JobCosting = lazy(() => import('./pages/JobCosting'));
const Compliance = lazy(() => import('./pages/Compliance'));
const Accounting = lazy(() => import('./pages/Accounting'));
const Production = lazy(() => import('./pages/Production'));
const Quality = lazy(() => import('./pages/Quality'));
const Commission = lazy(() => import('./pages/Commission'));
const Reports = lazy(() => import('./pages/Reports'));
const Stock = lazy(() => import('./pages/Stock'));
const Dtf = lazy(() => import('./pages/Dtf'));
import { useFeatures } from './hooks/useFeatures';
import SalesHub from './components/SalesHub';
import { priceListsFor } from '@glm/shared';
import type { PermissionKey } from '@glm/shared';

// The Commission module exists only while an Admin has switched the scheme on (Master Data → Company Info).
function CommissionGate() {
  const features = useFeatures();
  if (!features) return <p className="note">Loading…</p>;
  if (!features.commission) return <p className="note">Commission is switched off. An Admin can switch it on in Master Data → Company Info.</p>;
  return <Commission />;
}

function DefaultRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // someone who captures orders starts on their own sales screen: a sales person under Freelancer Sales, GLM's own staff under GLM Sales
  const lists = priceListsFor(user.role, user.permissions);
  return <Navigate to={user.permissions.canCaptureOrders && user.role !== 'Admin' ? (lists.includes('glm') ? '/orders/new/walkin' : '/freelancer/orders/new/walkin') : '/orders/all'} replace />;
}

// The seven sales screens exist under each price list: the original addresses are GLM Sales, the same screens under /freelancer are Freelancer Sales (the menu you key from decides the list). Each list is
// one place in the menu (SalesHub): a row of buttons across the top, the screen pressed below.
function salesRoutes(prefix: string) {
  const entries: [string, PermissionKey[], JSX.Element][] = [
    ['/orders/new/walkin', ['canCaptureOrders'], <NewWalkinOrder />],
    ['/orders/new/film', ['canAccessDtf', 'canManageDtf'], <NewFilmOrder />],
    ['/orders/new/artwork', ['canAccessDtf', 'canManageDtf'], <NewArtworkOrder />],
    ['/orders/new/uv-film', ['canAccessDtf', 'canManageDtf'], <NewFilmOrder product="uv" />],
    ['/orders/new/uv-artwork', ['canAccessDtf', 'canManageDtf'], <NewArtworkOrder product="uv" />],
    ['/orders/new/embroidery', ['canCaptureOrders'], <NewEmbroideryOrder />],
    ['/costing', ['canCaptureOrders', 'canAccessFinance'], <JobCosting />],
  ];
  return entries.map(([path, keys, screen]) => (
    <Route
      key={prefix + path}
      path={prefix + path}
      element={<RequirePermission keys={keys}>{screen}</RequirePermission>}
    />
  ));
}

export default function App() {
  const { user } = useAuth();

  return (
    <Suspense fallback={<p className="note" style={{ padding: 'var(--space-4)' }}>Loading…</p>}>
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public: what the system stores and why (Google asks for this address when Drive backups are connected). */}
      <Route path="/privacy" element={<Privacy />} />
      <Route element={user ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<DefaultRedirect />} />
        <Route element={<SalesHub list="glm" />}>{salesRoutes('')}</Route>
        <Route element={<SalesHub list="freelancer" />}>{salesRoutes('/freelancer')}</Route>
        {/* One Orders screen: the whole list for people who may see every order, a member of staff's own orders otherwise. */}
        <Route
          path="/orders/all"
          element={
            <RequirePermission keys={['canViewAllOrders', 'canCaptureOrders']}>
              <Orders />
            </RequirePermission>
          }
        />
        <Route path="/orders/mine" element={<Navigate to="/orders/all" replace />} />
        <Route
          path="/payments"
          element={
            <RequirePermission keys={['canManagePayments']}>
              <Payments />
            </RequirePermission>
          }
        />
        <Route
          path="/master-data"
          element={
            <RequireRole roles={['Admin']}>
              <MasterData />
            </RequireRole>
          }
        />
        {/* The Profit & Loss now lives in Accounting; an old bookmark lands there. */}
        <Route path="/pnl" element={<Navigate to="/accounting?tab=pl" replace />} />
        <Route path="/approvals" element={<Approvals />} />
        {/* The Client Register is a part of Commission now; an old link or bookmark lands there. */}
        <Route path="/client-register" element={<Navigate to="/commission?tab=register" replace />} />
        <Route
          path="/hr"
          element={
            <RequirePermission keys={['canAccessHr', 'canManageHr']}>
              <Hr />
            </RequirePermission>
          }
        />
        <Route
          path="/petty-cash"
          element={
            <RequirePermission keys={['canCapturePettyCash']}>
              <PettyCashDesk />
            </RequirePermission>
          }
        />
        <Route
          path="/finance"
          element={
            <RequirePermission keys={['canAccessFinance']}>
              <Finance />
            </RequirePermission>
          }
        />
        <Route
          path="/production"
          element={
            <RequirePermission keys={['canAccessProduction', 'canManageProduction']}>
              <Production />
            </RequirePermission>
          }
        />
        <Route
          path="/commission"
          element={
            <RequirePermission keys={['canCaptureOrders', 'canManageCommission', 'canCaptureForOthers']}>
              <CommissionGate />
            </RequirePermission>
          }
        />
        <Route
          path="/quality"
          element={
            <RequirePermission keys={['canAccessQuality']}>
              <Quality />
            </RequirePermission>
          }
        />
        <Route
          path="/accounting"
          element={
            <RequirePermission keys={['canAccessAccounting', 'canManagePayments', 'canAccessPnl']}>
              <Accounting />
            </RequirePermission>
          }
        />
        <Route
          path="/compliance"
          element={
            <RequirePermission keys={['canAccessFinance']}>
              <Compliance />
            </RequirePermission>
          }
        />
        <Route
          path="/reports"
          element={
            <RequirePermission keys={['canAccessReports']}>
              <Reports />
            </RequirePermission>
          }
        />
        <Route
          path="/stock"
          element={
            <RequirePermission keys={['canAccessStock']}>
              <Stock />
            </RequirePermission>
          }
        />
        <Route
          path="/dtf"
          element={
            <RequirePermission keys={['canManageDtf']}>
              <Dtf />
            </RequirePermission>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
