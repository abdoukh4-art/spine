import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { currentLocation, renderApp } from '../../test/render';
import {
  alertFiltersToParams,
  DEFAULT_ALERT_FILTERS,
  parseAlertFilters,
  toAlertListParams,
} from './filters';

describe('alert filters ↔ URL', () => {
  it('round-trips through search params and drops invalid values', () => {
    const filters = {
      ...DEFAULT_ALERT_FILTERS,
      status: ['new' as const, 'triaged' as const],
      severity: ['critical' as const],
      minScore: 60,
      category: 'malware' as const,
      q: ' beacon ',
      technique: 't1059',
      sort: 'score' as const,
      order: 'asc' as const,
    };
    const params = alertFiltersToParams(filters);
    expect(params.toString()).toBe(
      'status=new&status=triaged&severity=critical&minScore=60&category=malware&q=beacon&technique=T1059&sort=score&order=asc',
    );
    expect(parseAlertFilters(params)).toEqual({ ...filters, q: 'beacon', technique: 'T1059' });
    expect(
      parseAlertFilters(
        new URLSearchParams('status=bogus&severity=meh&minScore=500&category=nope'),
      ),
    ).toEqual(DEFAULT_ALERT_FILTERS);
    expect(alertFiltersToParams(DEFAULT_ALERT_FILTERS).toString()).toBe('');
    expect(toAlertListParams(filters)).toEqual({
      sort: 'score',
      order: 'asc',
      status: ['new', 'triaged'],
      severity: ['critical'],
      minScore: 60,
      category: 'malware',
      q: 'beacon',
      technique: 'T1059',
    });
  });
});

describe('AlertQueuePage', () => {
  it('lists alerts with severity, status, score and duplicates, and passes axe', async () => {
    const { container } = renderApp('/alerts');
    const link = await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    const row = link.closest('tr')!;
    expect(within(row).getByText('Critical')).toBeInTheDocument();
    expect(within(row).getByText('New')).toBeInTheDocument();
    expect(within(row).getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(link).toHaveAttribute('href', expect.stringMatching(/^\/alerts\/0192f0a0-/));
    expect(document.title).toBe('Alert queue · Spine');
    await expectNoAxeViolations(container);
  });

  it('applies filters to the URL and to the API query', async () => {
    const { user, server } = renderApp('/alerts');
    await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    const form = screen.getByRole('form', { name: 'Alert filters' });
    await user.click(within(form).getByRole('checkbox', { name: 'New' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Critical' }));
    await user.type(within(form).getByRole('spinbutton', { name: /Minimum score/ }), '80');
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Category' }),
      'credential_access',
    );
    await user.click(within(form).getByRole('button', { name: 'Apply filters' }));

    await waitFor(() =>
      expect(currentLocation()).toBe(
        '/alerts?status=new&severity=critical&minScore=80&category=credential_access',
      ),
    );
    expect(await screen.findByRole('link', { name: /Mimikatz/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Cobalt Strike/ })).not.toBeInTheDocument();
    expect(server.requests.at(-1)).toContain(
      'status=new&severity=critical&minScore=80&category=credential_access',
    );
  });

  it('reads filters from the URL on load (shareable views)', async () => {
    renderApp('/alerts?q=transfer.sh');
    expect(await screen.findByRole('link', { name: /Large upload/ })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /Search/ })).toHaveValue('transfer.sh');
    expect(screen.queryByRole('link', { name: /Cobalt Strike/ })).not.toBeInTheDocument();
  });

  it('sorts by score through the sortable header (aria-sort)', async () => {
    const { user } = renderApp('/alerts');
    await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    const received = screen.getByRole('columnheader', { name: /Received/ });
    expect(received).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: /Score/ }));
    await waitFor(() => expect(currentLocation()).toBe('/alerts?sort=score'));
    expect(screen.getByRole('columnheader', { name: /Score/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: /Received/ })).not.toHaveAttribute('aria-sort');
    await user.click(screen.getByRole('button', { name: /Score/ }));
    await waitFor(() => expect(currentLocation()).toBe('/alerts?sort=score&order=asc'));
  });

  it('resets filters', async () => {
    const { user } = renderApp('/alerts?status=resolved');
    await screen.findAllByRole('link', { name: /Ransom note/ });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(currentLocation()).toBe('/alerts'));
  });

  it('loads more with the cursor', async () => {
    const { user, server } = renderApp('/alerts');
    await screen.findByRole('link', { name: /Cobalt Strike beacon/ });
    expect(screen.getByText('Showing 25 items')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 50 items')).toBeInTheDocument();
    expect(server.requests.at(-1)).toMatch(/cursor=/);
  });

  it('shows an empty state when nothing matches', async () => {
    renderApp('/alerts?q=no-such-alert-anywhere');
    expect(await screen.findByText('No alerts match these filters.')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    const { user, server } = renderApp('/alerts', 'analyst');
    server.failNext('GET', '/alerts', 500);
    expect(await screen.findByRole('alert')).toHaveTextContent('Injected failure');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Cobalt Strike beacon/ })).toBeInTheDocument();
  });
});
