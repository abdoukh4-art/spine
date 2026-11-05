import { QueryClient } from '@tanstack/react-query';
import { render, screen, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AppProviders } from '../app/App';
import { AppRoutes } from '../app/routes';
import { DEMO_USERS } from '../fake/fixtures';
import { FakeSpineServer, type FakeServerOptions } from '../fake/server';
import { createSpineApi, HttpClient, type SpineApi } from '../lib/api';

import { TEST_NOW } from './time';

export { TEST_NOW };

/** Which demo account the test is logged in as (`null` = logged out). */
export type TestRole = keyof typeof DEMO_USERS | null;

/** Everything a test needs to drive and inspect the app. */
export interface RenderedApp extends RenderResult {
  server: FakeSpineServer;
  api: SpineApi;
  queryClient: QueryClient;
  user: UserEvent;
}

/** A query client tuned for tests: no retries (errors surface at once), no GC surprises. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** A fake server + real HTTP client + API, optionally pre-signed-in (refresh cookie set). */
export function createTestBackend(as: TestRole = 'analyst', options: FakeServerOptions = {}) {
  const server = new FakeSpineServer({ now: () => TEST_NOW, ...options });
  if (as) server.signInAs(DEMO_USERS[as].email);
  const api = createSpineApi(new HttpClient({ fetch: server.fetch }));
  return { server, api };
}

/** Exposes the current location for assertions on URL state (filters ↔ search params). */
export function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/**
 * Renders the **whole app** (providers, auth, routes, lazy pages) at `route`, backed by the
 * typed fake API. This is the default for page tests: it exercises the real client.
 */
export function renderApp(
  route: string,
  as: TestRole = 'analyst',
  options: FakeServerOptions = {},
): RenderedApp {
  const { server, api } = createTestBackend(as, options);
  const queryClient = createTestQueryClient();
  const user = userEvent.setup();
  const result = render(
    <AppProviders api={api} queryClient={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...result, server, api, queryClient, user };
}

/** Current location as rendered by {@link LocationProbe}. */
export function currentLocation(): string {
  return screen.getByTestId('location').textContent;
}
