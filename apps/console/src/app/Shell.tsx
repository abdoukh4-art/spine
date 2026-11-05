import { Suspense } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Badge, Button, Select, Spinner } from '../components';
import { useAuth, useCan } from '../lib/auth/AuthProvider';
import { useTheme, type ThemePreference } from '../lib/theme';

/** Navigation entries; `admin` ones are only shown to admins (the routes are guarded too). */
const NAV: { to: string; label: string; admin?: boolean }[] = [
  { to: '/alerts', label: 'Alerts' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/runs', label: 'Runs' },
  { to: '/playbooks', label: 'Playbooks' },
  { to: '/metrics', label: 'Metrics' },
  { to: '/simulated-actions', label: 'Simulated actions' },
  { to: '/admin/users', label: 'Users', admin: true },
  { to: '/admin/audit-log', label: 'Audit log', admin: true },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System theme' },
  { value: 'light', label: 'Light theme' },
  { value: 'dark', label: 'Dark theme' },
];

/** Theme picker: a native select is keyboard- and screen-reader-friendly out of the box. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <Select
      label="Colour theme"
      labelHidden
      options={THEME_OPTIONS}
      value={preference}
      onChange={(event) => setPreference(event.target.value as ThemePreference)}
    />
  );
}

/**
 * The authenticated layout: skip link, banner with navigation and user menu, and one
 * `<main>` landmark. Pages are lazy-loaded inside it (route-level code splitting).
 */
export function Shell() {
  const { user, logout } = useAuth();
  const isAdmin = useCan('admin');
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="sp-header">
        <Link to="/alerts" className="sp-brand">
          Spine <span className="sp-brand__tag">SOAR console</span>
        </Link>
        <nav aria-label="Main" className="sp-nav">
          <ul>
            {NAV.filter((item) => !item.admin || isAdmin).map((item) => (
              <li key={item.to}>
                <NavLink to={item.to}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sp-header__user">
          {user ? (
            <span>
              <span className="visually-hidden">Signed in as </span>
              {user.displayName} <Badge tone="info">{user.role}</Badge>
            </span>
          ) : null}
          <ThemeToggle />
          <Button size="sm" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </header>
      <main id="main" className="sp-main" tabIndex={-1}>
        <Suspense fallback={<Spinner label="Loading page" />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
