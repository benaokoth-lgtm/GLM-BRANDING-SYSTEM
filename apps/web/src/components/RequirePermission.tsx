import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { PermissionKey } from '@glm/shared';
import { useAuth } from '../state/AuthContext';

// Any one of `keys` grants access (OR semantics, matching RequireRole's
// multi-role behavior) — 'Admin' always passes regardless of its stored
// permissions, same rule the backend's requirePermission() enforces.
export default function RequirePermission({ keys, children }: { keys: PermissionKey[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'Admin' && !keys.some((k) => user.permissions[k])) {
    return <p className="note">You don't have access to this screen.</p>;
  }
  return <>{children}</>;
}
