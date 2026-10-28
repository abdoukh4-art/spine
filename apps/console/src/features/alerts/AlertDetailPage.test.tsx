import { ALERT_STATUSES } from '@spine/shared-schema';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeId, ID_KIND } from '../../fake/ids';
import { expectNoAxeViolations } from '../../test/axe';
import { currentLocation, renderApp } from '../../test/render';
import { allowedTransitions } from './AlertActions';
import { canonicalFields } from './AlertDetailPage';
import { groupByIndicator, summarizeEnrichment } from './EnrichmentResults';
import { formatPoints, ScoreExplanationView } from './ScoreExplanationView';

const C2 = fakeId(ID_KIND.alert, 1); // new, score 100 (raw 105), 3 duplicates
const SPRAYING = fakeId(ID_KIND.alert, 3); // in_progress
const EXPLOIT = fakeId(ID_KIND.alert, 5); // geo-ip circuit open → data gap
const POWERSHELL = fakeId(ID_KIND.alert, 7); // not scored yet
const RANSOMWARE = fakeId(ID_KIND.alert, 9); // resolved

async function openDetail(id: string, as: 'viewer' | 'analyst' | 'admin' = 'analyst') {
  const app = renderApp(`/alerts/${id}`, as);
  await screen.findByRole('heading', { name: 'Why this score?' });
  return app;
}

describe('score explanation', () => {
  it('renders every factor with signed points, evidence, and the clamped total', async () => {
    await openDetail(C2);
    const table = screen.getByRole('table', { name: 'Score factors' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(1 + 5 + 1); // header, five factors, total
    expect(
      within(table).getByRole('rowheader', { name: 'malicious-reputation' }).closest('tr'),
    ).toHaveTextContent(/185\.220\.101\.47: malicious \(97\/100, abuse-db\).*\+25/);
    expect(within(table).getByText('Raw total (clamped to 0–100)')).toBeInTheDocument();
    expect(within(table).getByText('105 → 100')).toBeInTheDocument();
  });

  it('calls out data gaps when a provider failed', async () => {
    await openDetail(EXPLOIT);
    const gap = screen.getByRole('complementary', { name: 'Data gaps: this score may be too low' });
    expect(gap).toHaveTextContent('geo-ip');
  });

  it('says so when the alert is not scored yet', async () => {
    await openDetail(POWERSHELL);
    expect(screen.getByText(/has not been scored yet/)).toBeInTheDocument();
    expect(screen.getByText('No enrichment results yet.')).toBeInTheDocument();
  });

  it('formats negative points with a real minus sign', () => {
    expect(formatPoints(25)).toBe('+25');
    expect(formatPoints(-10)).toBe('−10');
    expect(formatPoints(0)).toBe('0');
    render(
      <ScoreExplanationView
        score={{
          score: 0,
          rawScore: -5,
          severity: 'informational',
          rulesetVersion: 1,
          factors: [{ ruleId: 'benign', description: 'Benign', points: -5 }],
          dataGaps: [],
          computedAt: '2026-10-28T12:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByText('−5')).toBeInTheDocument();
    expect(screen.getByText('-5 → 0')).toBeInTheDocument();
  });
});

describe('alert detail page', () => {
  it('shows summary, canonical fields, MITRE, enrichment by indicator and related runs; passes axe', async () => {
    const { container } = await openDetail(C2);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cobalt Strike beacon');
    expect(
      screen.getByText('fin-ws-0231 · 10.20.4.31 · Windows 11 Enterprise 23H2'),
    ).toBeInTheDocument();
    expect(screen.getByText('10.20.4.31:51544 → 185.220.101.47:443 (tcp)')).toBeInTheDocument();
    expect(screen.getByText('T1071.001')).toBeInTheDocument();
    const enrichment = screen.getByRole('table', { name: 'ipv4: 185.220.101.47' });
    expect(within(enrichment).getByText('abuse-db').closest('tr')).toHaveTextContent(
      /Ok.*Malicious.*Reputation 97\/100/,
    );
    expect(within(enrichment).getByText('geo-ip').closest('tr')).toHaveTextContent('Tor exit node');
    const runs = screen.getByRole('table', { name: 'Runs for this alert' });
    expect(within(runs).getByText('Waiting approval')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('offers only the allowed status transitions', async () => {
    await openDetail(C2);
    const select = screen.getByRole('combobox', { name: 'Move to status' });
    const offered = within(select)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(offered).toEqual(['triaged', 'in_progress', 'resolved', 'false_positive']);
  });

  it('offers only "reopen" for a closed alert', async () => {
    await openDetail(RANSOMWARE);
    const select = screen.getByRole('combobox', { name: 'Move to status' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['In progress']);
  });

  it('matches the contract state machine for every status', () => {
    expect(ALERT_STATUSES.map((s) => [s, allowedTransitions(s)])).toEqual([
      ['new', ['triaged', 'in_progress', 'resolved', 'false_positive']],
      ['triaged', ['in_progress', 'resolved', 'false_positive']],
      ['in_progress', ['triaged', 'resolved', 'false_positive']],
      ['resolved', ['in_progress']],
      ['false_positive', ['in_progress']],
    ]);
  });

  it('changes the status and then offers the next transitions', async () => {
    const { user, server } = await openDetail(SPRAYING);
    const select = screen.getByRole('combobox', { name: 'Move to status' });
    await user.selectOptions(select, 'resolved');
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    expect(await screen.findByText('Status changed to Resolved.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('combobox', { name: 'Move to status' }))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['In progress']),
    );
    expect(server.db.alerts[2]?.alert.status).toBe('resolved');
  });

  it('reports a 409 when someone else changed the alert first', async () => {
    const { user, server } = await openDetail(C2);
    server.failNext('PATCH', `/alerts/${C2}`, 409, 'conflict', 'Illegal status transition');
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    expect(await screen.findByText(/Someone changed this alert first/)).toBeInTheDocument();
  });

  it('assigns the alert to me and unassigns', async () => {
    const { user } = await openDetail(C2);
    await user.click(screen.getByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByRole('button', { name: 'Unassign me' })).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unassign me' }));
    expect(await screen.findByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
  });

  it('re-runs enrichment and the data gap disappears', async () => {
    const { user, server } = await openDetail(EXPLOIT);
    await user.click(screen.getByRole('button', { name: 'Re-run enrichment' }));
    expect(await screen.findByText(/Re-enrichment requested/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: /Data gaps/ })).not.toBeInTheDocument(),
    );
    expect(server.count(`POST /alerts/${EXPLOIT}/enrich`)).toBe(1);
  });

  it('starts a dry-run playbook and navigates to the run', async () => {
    const { user, server } = await openDetail(C2);
    await screen.findByRole('option', { name: 'Contain C2 beacon' });
    expect(screen.getByRole('checkbox', { name: /Dry run/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Run of contain-c2-beacon' }),
    ).toBeInTheDocument();
    expect(currentLocation()).toMatch(/^\/runs\/0192f0a0-/);
    expect(server.db.runs[0]?.run.dryRun).toBe(true);
    expect(server.db.runs[0]?.run.trigger).toBe('manual');
  });

  it('hides every action from viewers (read-only)', async () => {
    await openDetail(C2, 'viewer');
    expect(screen.getByText(/You have read-only access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start run' })).not.toBeInTheDocument();
  });

  it('shows a not-found error for an unknown alert', async () => {
    renderApp(`/alerts/${fakeId(ID_KIND.alert, 99_999)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Alert not found');
  });
});

describe('alert detail helpers', () => {
  it('summarizes each enrichment payload kind', () => {
    expect(summarizeEnrichment(undefined)).toBe('—');
    expect(
      summarizeEnrichment({ kind: 'reputation', score: 10, verdict: 'benign', tags: [] }),
    ).toBe('Reputation 10/100');
    expect(summarizeEnrichment({ kind: 'geo', country: 'FR', asn: 1, isTor: false })).toBe(
      'FR · AS1',
    );
    expect(
      summarizeEnrichment({ kind: 'asset', hostname: 'h', criticality: 'low', tags: [] }),
    ).toBe('Asset h · criticality low');
  });

  it('groups results by indicator in first-seen order', () => {
    const base = { status: 'ok' as const, durationMs: 1, fetchedAt: '2026-10-28T12:00:00.000Z' };
    const groups = groupByIndicator([
      { ...base, provider: 'a', indicator: { type: 'ipv4', value: '1.1.1.1' } },
      { ...base, provider: 'b', indicator: { type: 'domain', value: 'x.y' } },
      { ...base, provider: 'c', indicator: { type: 'ipv4', value: '1.1.1.1' } },
    ]);
    expect(groups.map(([k, v]) => [k, v.length])).toEqual([
      ['ipv4: 1.1.1.1', 2],
      ['domain: x.y', 1],
    ]);
  });

  it('lists canonical fields, including labels', () => {
    const items = canonicalFields({
      id: C2,
      fingerprint: 'f'.repeat(64),
      status: 'new',
      receivedAt: '2026-10-28T12:00:00.000Z',
      lastSeenAt: '2026-10-28T12:00:00.000Z',
      duplicateCount: 0,
      source: { vendor: 'v', product: 'p' },
      title: 't',
      category: 'other',
      severity: 'low',
      occurredAt: '2026-10-28T12:00:00.000Z',
      user: { name: 'bob' },
      network: { destinationIp: '10.0.0.1' },
      file: { name: 'a.exe' },
      url: 'https://example.com/',
      indicators: [],
      mitre: [],
      labels: { env: 'prod' },
    });
    expect(items.map((i) => i.label)).toEqual(['User', 'Network', 'File', 'URL', 'Label: env']);
    expect(items[1]?.value).toBe('? → 10.0.0.1');
  });
});
