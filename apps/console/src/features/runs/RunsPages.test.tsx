import { RUN_EVENT_TYPES, type RunEvent } from '@spine/shared-schema';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeId, ID_KIND } from '../../fake/ids';
import { expectNoAxeViolations } from '../../test/axe';
import { currentLocation, renderApp } from '../../test/render';
import { describeRunEvent, toTimeline } from './describeEvent';
import { isTerminal } from './RunDetailPage';
import { runDurationSeconds } from './RunsTable';

const COMPENSATED_RUN = fakeId(ID_KIND.run, 5);
const LIVE_RUN = fakeId(ID_KIND.run, 7); // running, with planned events

describe('run detail', () => {
  it('shows step states and a readable timeline for a compensated run; passes axe', async () => {
    const { container } = renderApp(`/runs/${COMPENSATED_RUN}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Run of contain-c2-beacon' }),
    ).toBeInTheDocument();
    const steps = screen.getByRole('table', { name: 'Steps in definition order' });
    expect(
      within(steps).getByRole('rowheader', { name: 'block-ip' }).closest('tr'),
    ).toHaveTextContent('Compensated');
    expect(
      within(steps).getByRole('rowheader', { name: 'open-ticket' }).closest('tr'),
    ).toHaveTextContent(/Failed\s*2/);
    expect(
      within(steps).getByRole('rowheader', { name: 'notify-soc' }).closest('tr'),
    ).toHaveTextContent('Pending');
    const timeline = screen.getByRole('list', { name: 'Run events, oldest first' });
    expect(within(timeline).getByText('Approved by Ada Admin')).toBeInTheDocument();
    expect(within(timeline).getByText('Retry of “open-ticket” scheduled')).toBeInTheDocument();
    expect(
      within(timeline).getByText('Run compensated: completed steps were undone'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('auto-refreshes a live run until it is terminal', async () => {
    const { server } = renderApp(`/runs/${LIVE_RUN}`);
    // The fake emits one planned event per poll; keep only the last two so the test is quick.
    const planned = server.db.runs.find((r) => r.run.id === LIVE_RUN)!.planned;
    planned.splice(0, planned.length - 2);
    expect(await screen.findByText(/Live: refreshing every 3 s/)).toBeInTheDocument();
    expect(await screen.findByText('Run succeeded', {}, { timeout: 10_000 })).toBeInTheDocument();
    const polls = server.count(`GET /runs/${LIVE_RUN}`);
    expect(polls).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(server.count(`GET /runs/${LIVE_RUN}`)).toBe(polls); // stopped polling
  }, 20_000);

  it('lets an analyst cancel a live run', async () => {
    const { user, server } = renderApp(`/runs/${LIVE_RUN}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Cancellation requested.')).toBeInTheDocument();
    await waitFor(() =>
      expect(server.db.runs.find((r) => r.run.id === LIVE_RUN)?.run.status).toBe('cancelled'),
    );
  });

  it('hides cancel from viewers', async () => {
    renderApp(`/runs/${LIVE_RUN}`, 'viewer');
    await screen.findByRole('heading', { name: 'Timeline' });
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });
});

describe('runs list', () => {
  it('lists runs and filters by status in the URL', async () => {
    const { user, container } = renderApp('/runs');
    const table = await screen.findByRole('table', { name: 'Playbook runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed');
    await waitFor(() => expect(currentLocation()).toBe('/runs?status=failed'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Playbook runs' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    await expectNoAxeViolations(container);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'cancelled');
    expect(await screen.findByText('No runs match.')).toBeInTheDocument();
  });
});

describe('describeRunEvent', () => {
  const event = (
    type: RunEvent['type'],
    payload: Record<string, unknown> = {},
    stepId: string | null = 's1',
  ): RunEvent => ({
    runId: fakeId(ID_KIND.run, 1),
    seq: 1,
    type,
    stepId,
    payload,
    occurredAt: '2026-10-28T12:00:00.000Z',
  });

  it('describes every event type in the contract', () => {
    for (const type of RUN_EVENT_TYPES) {
      const d = describeRunEvent(event(type));
      expect(d.title.length, type).toBeGreaterThan(3);
    }
  });

  it('includes payload details defensively', () => {
    expect(
      describeRunEvent(event('step.failed', { error: 'boom', attempt: 2, continued: true })),
    ).toEqual({
      title: 'Step “s1” failed (attempt 2)',
      description: 'boom. Continuing (onFailure: continue)',
      tone: 'danger',
    });
    expect(describeRunEvent(event('step.failed', { error: 42 })).description).toBe('42');
    expect(describeRunEvent(event('step.failed', { error: { nested: true } })).description).toBe(
      'No error message',
    );
    expect(describeRunEvent(event('step.started', { attempt: 3 })).description).toBe('Attempt 3');
    expect(describeRunEvent(event('step.succeeded', { taken: 'next' })).description).toBe(
      'Branch taken → next',
    );
    expect(describeRunEvent(event('run.started', { dryRun: true })).title).toBe('Dry run started');
    expect(describeRunEvent(event('run.cancelled', { by: 'Sam' })).description).toBe('By Sam');
    expect(describeRunEvent(event('compensation.step_failed')).description).toBe(
      'Manual clean-up needed',
    );
    expect(toTimeline([event('run.succeeded', {}, null)])[0]).toMatchObject({
      id: '1',
      title: 'Run succeeded',
      tone: 'success',
    });
  });

  it('computes durations and terminal states', () => {
    expect(
      runDurationSeconds({
        startedAt: '2026-10-28T12:00:00.000Z',
        finishedAt: '2026-10-28T12:01:30.000Z',
      }),
    ).toBe(90);
    expect(runDurationSeconds({ startedAt: null, finishedAt: null })).toBeNull();
    expect(isTerminal({ status: 'compensated' })).toBe(true);
    expect(isTerminal({ status: 'waiting_approval' })).toBe(false);
  });
});
