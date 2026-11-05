import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Spinner } from '../components';
import { RequireAuth, RequireRole } from '../lib/auth/guards';
import { Shell } from './Shell';

/*
 * Route-level code splitting: each page is its own chunk, loaded on first visit. The
 * shell, the API client and the design system are in the main chunk.
 */
const LoginPage = lazy(() => import('../features/auth/LoginPage'));
const AlertQueuePage = lazy(() => import('../features/alerts/AlertQueuePage'));
const AlertDetailPage = lazy(() => import('../features/alerts/AlertDetailPage'));
const RunsPage = lazy(() => import('../features/runs/RunsPage'));
const RunDetailPage = lazy(() => import('../features/runs/RunDetailPage'));
const ApprovalsPage = lazy(() => import('../features/approvals/ApprovalsPage'));
const PlaybooksPage = lazy(() => import('../features/playbooks/PlaybooksPage'));
const PlaybookDetailPage = lazy(() => import('../features/playbooks/PlaybookDetailPage'));
const MetricsPage = lazy(() => import('../features/metrics/MetricsPage'));
const SimulatedActionsPage = lazy(() => import('../features/simulated/SimulatedActionsPage'));
const UsersPage = lazy(() => import('../features/admin/UsersPage'));
const AuditLogPage = lazy(() => import('../features/admin/AuditLogPage'));
const NotFoundPage = lazy(() => import('../features/NotFoundPage'));

/** Every route of the console. Rendered inside a router (Browser in the app, Memory in tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense fallback={<Spinner label="Loading page" />}>
            <LoginPage />
          </Suspense>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/alerts" replace />} />
        <Route path="alerts" element={<AlertQueuePage />} />
        <Route path="alerts/:id" element={<AlertDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="playbooks" element={<PlaybooksPage />} />
        <Route path="playbooks/:id" element={<PlaybookDetailPage />} />
        <Route path="metrics" element={<MetricsPage />} />
        <Route path="simulated-actions" element={<SimulatedActionsPage />} />
        <Route
          path="admin/users"
          element={
            <RequireRole role="admin">
              <UsersPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/audit-log"
          element={
            <RequireRole role="admin">
              <AuditLogPage />
            </RequireRole>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
