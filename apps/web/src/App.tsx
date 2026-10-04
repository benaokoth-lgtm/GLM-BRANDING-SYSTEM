import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/AuthContext';
import AppLayout from './layouts/AppLayout';
import RequireRole from './components/RequireRole';
import RequirePermission from './components/RequirePermission';
import Login from './pages/Login';
import NewWalkinOrder from './pages/NewWalkinOrder';
import NewFilmOrder from './pages/NewFilmOrder';
import NewArtworkOrder from './pages/NewArtworkOrder';
import Orders from './pages/Orders';
import Payments from './pages/Payments';
import MasterData from './pages/MasterData';
import Finance from './pages/Finance';
import Compliance from './pages/Compliance';
import Accounting from './pages/Accounting';
import Production from './pages/Production';
import Quality from './pages/Quality';
import Commission from './pages/Commission';
import Reports from './pages/Reports';
import Stock from './pages/Stock';
import Dtf from './pages/Dtf';

function DefaultRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.permissions.canCaptureOrders && user.role !== 'Admin' ? '/orders/new/walkin' : '/orders/all'} replace />;
}

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={user ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<DefaultRedirect />} />
        <Route
          path="/orders/new/walkin"
          element={
            <RequirePermission keys={['canCaptureOrders']}>
              <NewWalkinOrder />
            </RequirePermission>
          }
        />
        <Route
          path="/orders/new/film"
          element={
            <RequirePermission keys={['canAccessDtf', 'canManageDtf']}>
              <NewFilmOrder />
            </RequirePermission>
          }
        />
        <Route
          path="/orders/new/artwork"
          element={
            <RequirePermission keys={['canAccessDtf', 'canManageDtf']}>
              <NewArtworkOrder />
            </RequirePermission>
          }
        />
        <Route
          path="/orders/mine"
          element={
            <RequirePermission keys={['canCaptureOrders']}>
              <Orders scope="mine" />
            </RequirePermission>
          }
        />
        <Route
          path="/orders/all"
          element={
            <RequirePermission keys={['canViewAllOrders']}>
              <Orders scope="all" />
            </RequirePermission>
          }
        />
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
            <RequirePermission keys={['canCaptureOrders', 'canManageCommission']}>
              <Commission />
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
  );
}
