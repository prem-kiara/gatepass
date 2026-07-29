import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth, homeFor } from './lib/auth';
import { LoadingBlock } from './components/ui';
import ForcePinChange from './components/ForcePinChange';
import Login from './pages/Login';
import Gate from './pages/Gate';
import Approvals from './pages/Approvals';
import Console from './pages/Console';
import Settings from './pages/Settings';

function Protected({ roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingBlock />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // Landing on a screen your role cannot use is a wrong turn, not an error —
  // send people to their own home rather than showing a "forbidden" page.
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;

  return children;
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingBlock />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export default function App() {
  const { user, loading } = useAuth();

  // A guard signed in with a temporary PIN must set a private one before doing
  // anything else — no route escapes this until it is done.
  if (!loading && user && user.must_change_pin) return <ForcePinChange />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/gate"
        element={
          <Protected roles={['SECURITY']}>
            <Gate />
          </Protected>
        }
      />
      <Route
        path="/approvals"
        element={
          <Protected roles={['ADMIN', 'SUPERADMIN']}>
            <Approvals />
          </Protected>
        }
      />
      <Route
        path="/console/*"
        element={
          <Protected roles={['SUPERADMIN']}>
            <Console />
          </Protected>
        }
      />
      <Route
        path="/settings"
        element={
          <Protected>
            <Settings />
          </Protected>
        }
      />
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}
