import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createQueryClient } from './app/App';
import { createSpineApi, HttpClient, type FetchLike } from './lib/api';
import { applyTheme, readThemePreference } from './lib/theme';
import './styles/tokens.css';
import './styles/components.css';

/**
 * Picks the transport: the real API (default), or the in-browser fake when the console
 * is built/served with `VITE_USE_FAKE_API=true` (standalone demo, ADR-0071). The fake is a
 * dynamic import, so it is a separate chunk that the real build never loads.
 */
async function createTransport(): Promise<FetchLike | undefined> {
  if (import.meta.env.VITE_USE_FAKE_API !== 'true') return undefined;
  const { createDemoServer } = await import('./fake/demo');
  return createDemoServer().fetch;
}

async function bootstrap(): Promise<void> {
  // Apply the stored theme before the first paint to avoid a light/dark flash.
  applyTheme(readThemePreference());
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root element');
  const fetchImpl = await createTransport();
  const api = createSpineApi(new HttpClient(fetchImpl ? { fetch: fetchImpl } : {}));
  createRoot(root).render(
    <StrictMode>
      <App api={api} queryClient={createQueryClient()} />
    </StrictMode>,
  );
}

void bootstrap();
