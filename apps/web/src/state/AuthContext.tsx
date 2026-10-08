import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Permissions, Role } from '@glm/shared';
import { api, clearToken, getToken, setToken } from '../api/client';
import { resetFeatures } from '../hooks/useFeatures';
import { resetCatalogCache } from '../hooks/useCatalog';

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
  // Set when the Admin emailed this person a PIN: they must choose their own before doing anything else.
  mustChangePin?: boolean;
  // How many digits their PIN has, and how many their role needs at least (the Admin and anyone handling money: 6).
  pinLength?: number;
  pinNeeds?: number;
}

// After a right PIN, an Admin may be asked for a code that was emailed to them.
export interface CodeStep {
  challenge: string;
  sentTo: string;
}

const USER_KEY = 'glm_pos_user';

interface AuthContextValue {
  user: CurrentUser | null;
  loginError: string | null;
  /** True when the PIN was right — signed in, or waiting for the emailed code (see codeStep). */
  login: (userId: number, pin: string) => Promise<boolean>;
  codeStep: CodeStep | null;
  submitCode: (code: string) => Promise<boolean>;
  cancelCode: () => void;
  logout: () => void;
  clearMustChangePin: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [codeStep, setCodeStep] = useState<CodeStep | null>(null);

  useEffect(() => {
    if (!getToken()) setUser(null);
  }, []);

  const login = useCallback(async (userId: number, pin: string) => {
    setLoginError(null);
    try {
      const res = await api.post<{ token?: string; user?: CurrentUser; codeRequired?: boolean; challenge?: string; sentTo?: string }>('/auth/login', { userId, pin });
      if (res.codeRequired && res.challenge) {
        setCodeStep({ challenge: res.challenge, sentTo: res.sentTo ?? '' });
        return true;
      }
      setToken(res.token!);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
      setUser(res.user!);
      return true;
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
      return false;
    }
  }, []);

  const submitCode = useCallback(async (code: string) => {
    if (!codeStep) return false;
    setLoginError(null);
    try {
      const res = await api.post<{ token: string; user: CurrentUser }>('/auth/login-code', { challenge: codeStep.challenge, code });
      setToken(res.token);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
      setCodeStep(null);
      setUser(res.user);
      return true;
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'That code did not work');
      return false;
    }
  }, [codeStep]);

  const cancelCode = useCallback(() => {
    setCodeStep(null);
    setLoginError(null);
  }, []);

  const clearMustChangePin = useCallback(() => {
    setUser((u) => {
      if (!u) return u;
      const next = { ...u, mustChangePin: false };
      localStorage.setItem(USER_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    clearToken();
    resetFeatures();
    resetCatalogCache();
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loginError, login, codeStep, submitCode, cancelCode, logout, clearMustChangePin }), [user, loginError, login, codeStep, submitCode, cancelCode, logout, clearMustChangePin]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
