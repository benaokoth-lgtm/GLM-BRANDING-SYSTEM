import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/AuthContext';
import AppLayout from './layouts/AppLayout';
import RequireRole from './components/RequireRole';
import Login from './pages/Login';
import NewWalkinOrder from './pages/NewWalkinOrder';
import NewQuotation from './pages/NewQuotation';
import Orders from './pages/Orders';
import PendingPayments from './pages/PendingPayments';
import MasterData from './pages/MasterData';

function DefaultRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'Staff' ? '/orders/new/walkin' : '/orders/all'} replace />;
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
            <RequireRole roles={['Staff']}>
              <NewWalkinOrder />
            </RequireRole>
          }
        />
        <Route
          path="/orders/new/quote"
          element={
            <RequireRole roles={['Staff']}>
              <NewQuotation />
            </RequireRole>
          }
        />
        <Route
          path="/orders/mine"
          element={
            <RequireRole roles={['Staff']}>
              <Orders scope="mine" />
            </RequireRole>
          }
        />
        <Route
          path="/orders/all"
          element={
            <RequireRole roles={['Supervisor', 'Admin']}>
              <Orders scope="all" />
            </RequireRole>
          }
        />
        <Route
          path="/payments/pending"
          element={
            <RequireRole roles={['Supervisor', 'Admin']}>
              <PendingPayments />
            </RequireRole>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
