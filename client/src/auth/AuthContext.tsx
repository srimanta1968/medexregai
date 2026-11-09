import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiRequest, ApiRequest } from '../lib/api';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
}

export interface SessionOrg {
  id: string;
  name: string;
  slug: string;
}

export interface Session {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
  org: SessionOrg;
  role: string;
}

export interface RegisterInput {
  fullName: string;
  email: string;
  password: string;
  firmName: string;
}

interface AuthState {
  session: Session | null;
  /** True until the stored session has been restored (or found absent). */
  restoring: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  /** Adopt a session issued elsewhere (invite acceptance). */
  adopt(session: Session): void;
  logout(): Promise<void>;
  /** Authenticated API call; refreshes the access token once if it has expired. */
  authedRequest<T>(path: string, init?: Omit<ApiRequest, 'token'>): Promise<T>;
}

// The refresh token survives reloads; the short-lived access token stays in memory.
// Moving the refresh token to an httpOnly cookie is tracked with the security work (E8).
const REFRESH_KEY = 'medexregai.refreshToken';

function readStoredRefresh(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function storeRefresh(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(REFRESH_KEY, token);
    } else {
      window.localStorage.removeItem(REFRESH_KEY);
    }
  } catch {
    // Storage unavailable (private mode): the session simply will not survive a reload.
  }
}

const AuthContext = createContext<AuthState | null>(null);

/** Holds the signed-in session for the app; restores it from the stored refresh token on load. */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState<boolean>(true);
  const sessionRef = useRef<Session | null>(null);

  const apply = useCallback((next: Session | null): void => {
    sessionRef.current = next;
    setSession(next);
    storeRefresh(next?.refreshToken ?? null);
  }, []);

  // Refresh tokens are single-use and the server revokes the whole session when one
  // is replayed, so concurrent callers (StrictMode's double effect, parallel requests
  // hitting TOKEN_EXPIRED) must share ONE in-flight refresh instead of each sending it.
  const inFlight = useRef<Promise<Session | null> | null>(null);

  const refresh = useCallback((): Promise<Session | null> => {
    if (inFlight.current) {
      return inFlight.current;
    }
    const stored = sessionRef.current?.refreshToken ?? readStoredRefresh();
    if (!stored) {
      return Promise.resolve(null);
    }
    inFlight.current = apiRequest<Session>('/api/auth/refresh', { method: 'POST', body: { refreshToken: stored } })
      .then((next) => {
        apply(next);
        return next;
      })
      .catch(() => {
        apply(null);
        return null;
      })
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  }, [apply]);

  useEffect(() => {
    refresh().finally(() => setRestoring(false));
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      apply(await apiRequest<Session>('/api/auth/login', { method: 'POST', body: { email, password } }));
    },
    [apply]
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<void> => {
      apply(await apiRequest<Session>('/api/auth/register', { method: 'POST', body: input }));
    },
    [apply]
  );

  const logout = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    apply(null);
    if (current) {
      try {
        await apiRequest('/api/auth/logout', { method: 'POST', token: current.token, body: { refreshToken: current.refreshToken } });
      } catch {
        // Already signed out locally; the server-side session expires on its own.
      }
    }
  }, [apply]);

  const authedRequest = useCallback(
    async <T,>(path: string, init: Omit<ApiRequest, 'token'> = {}): Promise<T> => {
      const current = sessionRef.current;
      if (!current) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Please sign in again.');
      }
      try {
        return await apiRequest<T>(path, { ...init, token: current.token });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') {
          const renewed = await refresh();
          if (renewed) {
            return apiRequest<T>(path, { ...init, token: renewed.token });
          }
        }
        throw err;
      }
    },
    [refresh]
  );

  const value = useMemo<AuthState>(
    () => ({ session, restoring, login, register, adopt: apply, logout, authedRequest }),
    [session, restoring, login, register, apply, logout, authedRequest]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Current session plus sign-in, sign-out and authenticated-request helpers. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
