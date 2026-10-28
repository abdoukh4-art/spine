import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { currentLocation, renderApp } from '../test/render';
import { localInputToIso } from './admin/AuditLogPage';
import { fieldErrorsFrom } from './admin/UsersPage';
import { shortDay } from './metrics/MetricsPage';
import { compactJson } from './simulated/SimulatedActionsPage';

describe('metrics page', () => {
  it('shows MTTD/MTTR tiles, accessible charts with a table alternative; passes axe', async () => {
    const { container } = renderApp('/metrics');
    const mttd = await screen.findByLabelText('MTTD statistics');
    expect(mttd).toHaveTextContent('Mean');
    expect(screen.getByLabelText('MTTR statistics')).toHaveTextContent('Still open');
    const chart = screen.getByRole('img', { name: 'Alerts by severity' });
    expect(chart).toHaveAccessibleDescription(/5 bars, total \d+\. Highest:/);
    const table = screen.getByRole('table', { name: 'Alerts by severity' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(table).getByRole('rowheader', { name: 'Critical' })).toBeInTheDocument();
    expect(screen.getByLabelText('Playbook outcomes')).toHaveTextContent('Success rate');
    await expectNoAxeViolations(container);
  });

  it('changes the window and keeps it in the URL', async () => {
    const { user, server } = renderApp('/metrics');
    await screen.findByRole('img', { name: 'Alerts per day (UTC)' });
    await user.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    await waitFor(() => expect(currentLocation()).toBe('/metrics?window=30d'));
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Alerts per day (UTC)' })).toHaveAccessibleDescription(
        /^3[01] bars/,
      ),
    );
    expect(server.requests.at(-1)).toMatch(
      /from=2026-09-28T12%3A00%3A00\.000Z&to=2026-10-28T12%3A00%3A00\.000Z/,
    );
  });

  it('formats day labels', () => {
    expect(shortDay('2026-10-28')).toBe('28 Oct');
    expect(shortDay('garbage')).toBe('garbage');
  });
});

describe('simulated actions page', () => {
  it('states clearly that actions are simulated, lists them, filters by kind; passes axe', async () => {
    const { user, container } = renderApp('/simulated-actions');
    expect(
      await screen.findByRole('complementary', {
        name: /SIMULATED: nothing here touched a real system/,
      }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Simulated actions, newest first' });
    expect(within(table).getAllByText('Firewall: block').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Dry run').length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Action type' }),
      'firewall.unblock',
    );
    await waitFor(() => expect(currentLocation()).toBe('/simulated-actions?kind=firewall.unblock'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Simulated actions, newest first' })).getAllByRole(
          'row',
        ),
      ).toHaveLength(2),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Action type' }), 'ticket.close');
    expect(await screen.findByText('No simulated actions yet.')).toBeInTheDocument();
  });

  it('renders request/response bodies compactly', () => {
    expect(compactJson({ a: 'x', b: 2, c: ['y'] })).toBe('a=x, b=2, c=["y"]');
  });
});

describe('admin: users', () => {
  it('lists users and passes axe', async () => {
    const { container } = renderApp('/admin/users', 'admin');
    const row = (await screen.findByRole('rowheader', { name: /Dan Former/ })).closest('tr')!;
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Ada Admin \(you\)/ })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('changes a role and disables a user (never yourself)', async () => {
    const { user, server } = renderApp('/admin/users', 'admin');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Role of Val Viewer' }),
      'analyst',
    );
    expect(await screen.findByText('Val Viewer: Analyst.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disable Sam Analyst' }));
    expect(await screen.findByText('Sam Analyst: disabled.')).toBeInTheDocument();
    expect(server.db.users.find((u) => u.displayName === 'Sam Analyst')?.disabled).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Role of Ada Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable Ada Admin/ })).not.toBeInTheDocument();
  });

  it('creates a user with client-side and server-side validation', async () => {
    const { user, server } = renderApp('/admin/users', 'admin');
    await user.click(await screen.findByRole('button', { name: 'New user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a user' });
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(within(dialog).getByRole('textbox', { name: 'Email' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(dialog).getByLabelText('Initial password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await user.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'sam@spine.local');
    await user.type(within(dialog).getByRole('textbox', { name: 'Display name' }), 'Duplicate Sam');
    await user.type(within(dialog).getByLabelText('Initial password'), 'a-long-enough-password');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A user with sam@spine.local already exists.',
    );

    await user.clear(within(dialog).getByRole('textbox', { name: 'Email' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'new@spine.local');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'analyst');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('Created Duplicate Sam.')).toBeInTheDocument();
    expect(server.findUserByEmail('new@spine.local')?.role).toBe('analyst');
    expect(await screen.findByRole('rowheader', { name: 'Duplicate Sam' })).toBeInTheDocument();
  });

  it('maps validation issues to fields', () => {
    expect(
      fieldErrorsFrom([
        { path: 'password', message: 'too short' },
        { path: 'password', message: 'x' },
        { path: 'other', message: 'y' },
      ]),
    ).toEqual({
      password: 'too short',
    });
  });
});

describe('admin: audit log', () => {
  it('lists entries, filters via the URL and passes axe', async () => {
    const { user, container, server } = renderApp('/admin/audit-log', 'admin');
    const table = await screen.findByRole('table', { name: 'Audit entries, newest first' });
    expect(
      within(table).getAllByRole('rowheader', { name: 'auth.login.succeeded' }).length,
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await user.type(screen.getByRole('textbox', { name: 'Action contains' }), 'approval');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(currentLocation()).toBe('/admin/audit-log?action=approval'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Audit entries, newest first' })).getAllByRole(
          'row',
        ),
      ).toHaveLength(3),
    );
    expect(server.requests.at(-1)).toContain('action=approval');
  });

  it('converts datetime-local input (UTC) to ISO', () => {
    expect(localInputToIso('2026-10-28T12:30')).toBe('2026-10-28T12:30:00.000Z');
    expect(localInputToIso('')).toBeUndefined();
    expect(localInputToIso('nonsense')).toBeUndefined();
  });

  it('is not reachable for analysts', async () => {
    renderApp('/admin/audit-log', 'analyst');
    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
  });
});
