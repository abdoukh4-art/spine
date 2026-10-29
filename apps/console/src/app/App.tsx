import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { ToastProvider } from '../components';
import { ApiProvider, isApiError, type SpineApi } from '../lib/api';
import { AuthProvider } from '../lib/auth/AuthProvider';
import { ThemeProvider } from '../lib/theme';
import { AppRoutes } from './routes';

/**
 * Query defaults. Retries skip 4xx errors (a 404 or 403 will not fix itself), and the
 * live views opt into polling individually (ADR-0074).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
    },
  });
}

/** Every context provider the console needs, in dependency order. Shared with the tests. */
export function AppProviders({
  api,
  queryClient,
  children,
}: {
  api: SpineApi;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>{children}</AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

/** Root component: providers + browser router + routes. The API client is injected. */
export function App({ api, queryClient }: { api: SpineApi; queryClient: QueryClient }) {
  return (
    <AppProviders api={api} queryClient={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}
