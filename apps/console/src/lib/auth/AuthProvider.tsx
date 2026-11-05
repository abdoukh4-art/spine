import { roleSatisfies, type Role, type User } from '@spine/shared-schema';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useApi, type Session } from '../api';

/** What the rest of the console knows about authentication. */
export interface AuthContextValue {
  /** `restoring` while the silent refresh on page load is in flight. */
  status: 'restoring' | 'authenticated' | 'anonymous';
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the login state. The access token itself never leaves the HTTP client's memory
 * (ADR-0016): this provider only mirrors the *user* into React state.
 *
 * On mount it performs a silent `POST /auth/refresh`, so a page reload keeps the session
 * through the HttpOnly refresh cookie without ever storing a token in Web Storage.
 * When the session ends (logout or a failed refresh) it clears the query cache so one
 * user's data can never be shown to the next user of the same tab.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => api.http.getSession());
  const [restoring, setRestoring] = useState(() => api.http.getSession() === null);

  useEffect(
    () =>
      api.http.subscribe((next) => {
        setSession(next);
        if (next === null) queryClient.clear();
      }),
    [api, queryClient],
  );

  useEffect(() => {
    if (!restoring) return;
    let active = true;
    api.http
      .refresh()
      .catch(() => null)
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [api, restoring]);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.auth.login(email, password);
    },
    [api],
  );
  const logout = useCallback(() => api.auth.logout(), [api]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: restoring ? 'restoring' : session ? 'authenticated' : 'anonymous',
      user: session?.user ?? null,
      login,
      logout,
    }),
    [restoring, session, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Returns the auth state. Throws outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/**
 * True if the current user's role grants at least `role` (viewer < analyst < admin).
 * Use it to **hide** actions; the server still enforces every permission (ADR-0017).
 */
export function useCan(role: Role): boolean {
  const { user } = useAuth();
  return user !== null && !user.disabled && roleSatisfies(user.role, role);
}
