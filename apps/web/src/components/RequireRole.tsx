import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { Role } from '@glm/shared';
import { useAuth } from '../state/AuthContext';

export default function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <p className="note">You don't have access to this screen.</p>;
  return <>{children}</>;
}
