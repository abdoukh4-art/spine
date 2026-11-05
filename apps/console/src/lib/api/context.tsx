import { createContext, useContext, type ReactNode } from 'react';
import type { SpineApi } from './client';

const ApiContext = createContext<SpineApi | null>(null);

/**
 * Makes the API client available to the tree. The client is injected (not imported as a
 * singleton) so tests and the standalone demo can pass one backed by the fake API.
 */
export function ApiProvider({ api, children }: { api: SpineApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** Returns the injected API client. Throws if used outside {@link ApiProvider}. */
export function useApi(): SpineApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}
