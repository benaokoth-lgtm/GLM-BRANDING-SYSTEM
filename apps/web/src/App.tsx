import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/AuthContext';
import AppLayout from './layouts/AppLayout';
import RequireRole from './components/RequireRole';
import RequirePermission from './components/RequirePermission';
import Login from './pages/Login';
import NewWalkinOrder from './pages/NewWalkinOrder';
import NewQuotation from './pages/NewQuotation';
import Orders from './pages/Orders';
import Payments from './pages/Payments';
import MasterData from './pages/MasterData';
import PnL from './pages/PnL';
import Finance from './pages/Finance';
import Compliance from './pages/Compliance';
import Reports from './pages/Reports';
import Stock from './pages/Stock';
import Film from './pages/Film';

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
          path="/orders/new/quote"
          element={
            <RequirePermission keys={['canCaptureOrders']}>
              <NewQuotation />
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
        <Route
          path="/pnl"
          element={
            <RequirePermission keys={['canAccessPnl']}>
              <PnL />
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
          path="/film"
          element={
            <RequirePermission keys={['canAccessFilm']}>
              <Film />
            </RequirePermission>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
