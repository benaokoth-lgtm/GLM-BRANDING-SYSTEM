import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Permissions, Role } from '@glm/shared';
import { api, clearToken, getToken, setToken } from '../api/client';

export interface CurrentUser {
  id: number;
  name: string;
  role: Role;
  // Snapshotted at login time — a permission change an Admin makes in Master
  // Data → Roles & Access takes effect on the backend immediately (see
  // requirePermission in apps/api/src/middleware/auth.ts), but this
  // frontend copy (and therefore the nav/route gates built from it) only
  // refreshes the next time the affected user logs in.
  permissions: Permissions;
}

const USER_KEY = 'glm_pos_user';

interface AuthContextValue {
  user: CurrentUser | null;
  loginError: string | null;
  login: (userId: number, pin: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  });
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) setUser(null);
  }, []);

  const login = useCallback(async (userId: number, pin: string) => {
    setLoginError(null);
    try {
      const res = await api.post<{ token: string; user: CurrentUser }>('/auth/login', { userId, pin });
      setToken(res.token);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
      setUser(res.user);
      return true;
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loginError, login, logout }), [user, loginError, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
