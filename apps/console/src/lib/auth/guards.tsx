import type { Role } from '@spine/shared-schema';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { PageHeader, Spinner } from '../../components';
import { useAuth, useCan } from './AuthProvider';

/** Renders children only for a logged-in user; otherwise redirects to `/login?next=…`. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'restoring') {
    return (
      <div className="sp-fullpage">
        <Spinner label="Restoring your session" />
      </div>
    );
  }
  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Route guard: renders children only if the user has at least `role`. Others see a
 * "not allowed" page (not a redirect, so the URL they followed stays visible).
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const allowed = useCan(role);
  if (!allowed) {
    return (
      <>
        <PageHeader title="Not allowed" />
        <p>
          This page needs the <strong>{role}</strong> role. Ask an administrator if you need access.
        </p>
      </>
    );
  }
  return <>{children}</>;
}

/**
 * Validates a post-login redirect target. Only same-origin absolute paths are allowed,
 * which prevents an open redirect via `?next=https://evil.example` or `//evil.example`.
 */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/alerts';
  }
  return next;
}
