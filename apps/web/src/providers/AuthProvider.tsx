import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SessionUserRecord } from '@eclens/shared';
import { api } from '@/api/client';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: SessionUserRecord | null;
  status: AuthStatus;
  /**
   * The permission list is issued by the API at login, so the UI hides the same
   * actions the server would refuse. It is a convenience, never the control:
   * every write endpoint re-checks on the server.
   */
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<SessionUserRecord>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUserRecord | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // The session lives in an httpOnly cookie, so a reload asks the API rather
  // than reading anything out of localStorage.
  useEffect(() => {
    let cancelled = false;
    api.auth
      .restore()
      .then((restored) => {
        if (cancelled) return;
        setUser(restored);
        setStatus(restored ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const loggedIn = await api.auth.login(email, password);
    setUser(loggedIn);
    setStatus('authenticated');
    return loggedIn;
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const can = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo(
    () => ({ user, status, can, login, logout }),
    [user, status, can, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
