import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEMO_PASSWORD } from '../fake/fixtures';
import { safeNextPath } from '../lib/auth/guards';
import { THEME_STORAGE_KEY } from '../lib/theme';
import { expectNoAxeViolations } from '../test/axe';
import { currentLocation, renderApp } from '../test/render';

describe('authentication', () => {
  it('redirects anonymous users to the login page with a return path', async () => {
    const { container } = renderApp('/alerts?status=new', null);
    expect(await screen.findByRole('heading', { name: 'Log in to Spine' })).toBeInTheDocument();
    expect(currentLocation()).toBe('/login?next=%2Falerts%3Fstatus%3Dnew');
    expect(document.title).toBe('Log in · Spine');
    await expectNoAxeViolations(container);
  });

  it('validates empty fields and shows a generic error for bad credentials', async () => {
    const { user } = renderApp('/login', null);
    await user.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAccessibleDescription(
      'Enter your email address.',
    );
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@spine.local');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('logs in and returns to the page the user asked for', async () => {
    const { user, server } = renderApp('/approvals', null);
    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'sam@spine.local');
    await user.type(screen.getByLabelText('Password'), DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeInTheDocument();
    expect(currentLocation()).toBe('/approvals');
    expect(server.count('POST /auth/login')).toBe(1);
  });

  it('ignores off-site return paths (no open redirect)', () => {
    expect(safeNextPath('//evil.example/x')).toBe('/alerts');
    expect(safeNextPath('https://evil.example')).toBe('/alerts');
    expect(safeNextPath('/\\evil.example')).toBe('/alerts');
    expect(safeNextPath(null)).toBe('/alerts');
    expect(safeNextPath('/runs?status=failed')).toBe('/runs?status=failed');
  });

  it('restores the session silently on load via the refresh cookie (page reload)', async () => {
    const { server } = renderApp('/alerts', 'analyst');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Alert queue' }),
    ).toBeInTheDocument();
    expect(server.count('POST /auth/refresh')).toBe(1);
    expect(server.count('POST /auth/login')).toBe(0);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('refreshes once when several requests hit 401 at the same time', async () => {
    const { server, user } = renderApp('/alerts', 'analyst');
    const link = await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    server.expireAccessTokens();
    // The detail page fires GET /alerts/:id and GET /playbooks in parallel: both get 401.
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Why this score?' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Contain C2 beacon' })).toBeInTheDocument();
    expect(server.count('POST /auth/refresh')).toBe(2); // 1 on load + exactly 1 for the burst
  });

  it('logs out when the refresh fails (session revoked server-side)', async () => {
    const { server, queryClient } = renderApp('/alerts', 'analyst');
    await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    server.expireAccessTokens();
    server.cookieJar.clear();
    await queryClient.refetchQueries();
    expect(await screen.findByRole('heading', { name: 'Log in to Spine' })).toBeInTheDocument();
  });

  it('logs out from the header', async () => {
    const { server, user } = renderApp('/alerts', 'analyst');
    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in to Spine' })).toBeInTheDocument();
    expect(server.count('POST /auth/logout')).toBe(1);
    expect(server.cookieJar.get()).toBeNull();
  });
});

describe('app shell', () => {
  it('has a skip link, banner, labelled navigation, one main landmark, and the user', async () => {
    const { container } = renderApp('/alerts', 'analyst');
    await screen.findByRole('heading', { level: 1, name: 'Alert queue' });
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('banner')).toHaveTextContent('Sam Analyst');
    expect(screen.getByRole('banner')).toHaveTextContent('analyst');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Alerts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoAxeViolations(container);
  });

  it('shows admin navigation to admins only', async () => {
    renderApp('/alerts', 'analyst');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();
  });

  it('shows Users and Audit log to admins', async () => {
    renderApp('/alerts', 'admin');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('guards admin routes even when the URL is typed directly', async () => {
    const { server } = renderApp('/admin/users', 'viewer');
    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
    expect(server.count('GET /users')).toBe(0);
  });

  it('moves focus to the new page heading and updates the title after navigation', async () => {
    const { user } = renderApp('/alerts', 'analyst');
    await screen.findByRole('heading', { level: 1, name: 'Alert queue' });
    await user.click(screen.getByRole('link', { name: 'Approvals' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Approvals' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.title).toBe('Approvals · Spine');
  });

  it('persists the theme choice in localStorage and applies it', async () => {
    const { user } = renderApp('/alerts', 'analyst');
    const select = await screen.findByRole('combobox', { name: 'Colour theme' });
    await user.selectOptions(select, 'dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await user.selectOptions(select, 'system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('renders a 404 page for unknown paths', async () => {
    const { container } = renderApp('/no/such/page', 'viewer');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('redirects / to the alert queue', async () => {
    renderApp('/', 'viewer');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Alert queue' }),
    ).toBeInTheDocument();
  });
});
