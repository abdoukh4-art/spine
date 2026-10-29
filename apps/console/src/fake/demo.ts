import { documentCookieJar } from './http';
import { FakeSpineServer } from './server';

/**
 * The fake server as used by the standalone demo: fixtures relative to page-load time,
 * a little latency so loading states are visible, and a cookie-backed "refresh session"
 * so a reload keeps you logged in, exactly like the real HttpOnly cookie would.
 */
export function createDemoServer(): FakeSpineServer {
  return new FakeSpineServer({ cookieJar: documentCookieJar(), latencyMs: 250 });
}
