import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Permission, SessionResponse } from '@uxe/contracts';
import { ApiError, api, setCsrfToken, setUnauthorizedHandler } from './api.js';

interface SessionContextValue {
  session: SessionResponse | null;
  isLoading: boolean;
  error: ApiError | null;
  /** Permission check used to decide what to render. The server checks again regardless. */
  can: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const query: UseQueryResult<SessionResponse, ApiError> = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/auth/session'),
    // A 401 here is the normal signed-out state, not a transient failure worth retrying.
    retry: (count, error) => !(error instanceof ApiError && error.isAuthError) && count < 2,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // The CSRF token lives in memory only; it is re-seeded whenever the session is read.
  useEffect(() => {
    setCsrfToken(query.data?.csrfToken ?? null);
  }, [query.data?.csrfToken]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      queryClient.setQueryData(['session'], null);
    });
  }, [queryClient]);

  const permissions = useMemo(
    () => new Set(query.data?.permissions ?? []),
    [query.data?.permissions],
  );

  const can = useCallback((permission: Permission) => permissions.has(permission), [permissions]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      // Everything cached is tenant data; keeping any of it after sign-out would leak it
      // into the next session on a shared machine.
      //
      // The session query is emptied rather than removed. `queryClient.clear()` drops the
      // query out from under its observer without giving it a new result, so the app would
      // keep rendering the signed-out user's workspace until something else forced a
      // render — which is what used to happen here.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      queryClient.setQueryData(['session'], null);
    }
  }, [queryClient]);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      const next = await api.post<SessionResponse>('/auth/switch-workspace', { workspaceId });
      setCsrfToken(next.csrfToken);
      // Every cached list is scoped to the previous workspace. The session itself is
      // replaced rather than dropped, for the same reason as in `signOut`.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      queryClient.setQueryData(['session'], next);
    },
    [queryClient],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session: query.data ?? null,
      isLoading: query.isLoading,
      error: (query.error as ApiError | null) ?? null,
      can,
      refresh,
      signOut,
      switchWorkspace,
    }),
    [query.data, query.isLoading, query.error, can, refresh, signOut, switchWorkspace],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}

/** Convenience for components that only render when signed in. */
export function useCurrentUser() {
  const { session } = useSession();
  if (!session) throw new Error('useCurrentUser requires an authenticated session');
  return session.user;
}

export function useWorkspace() {
  const { session } = useSession();
  return session?.workspace ?? null;
}
