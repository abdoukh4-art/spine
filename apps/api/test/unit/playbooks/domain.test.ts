import { reduce, type RunEventRecord } from '@spine/playbook-engine';
import { PlaybookDefinitionSchema } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import {
  approvalDeadline,
  decisionProblem,
  timeoutOutcome,
} from '../../../src/modules/playbooks/domain/approval.js';
import { selectIndicatorsToBlock } from '../../../src/modules/playbooks/domain/indicators.js';
import {
  domainEventsFor,
  isTerminalEvent,
  projectionOf,
  toStepStates,
} from '../../../src/modules/playbooks/domain/run-view.js';
import { matchesTrigger } from '../../../src/modules/playbooks/domain/trigger.js';
import { alertFixture, enrichmentFixture, snapshotFixture } from './fixtures.js';

const definition = PlaybookDefinitionSchema.parse({
  apiVersion: 'spine/v1',
  kind: 'Playbook',
  metadata: { id: 'demo', name: 'Demo', version: 2 },
  trigger: {
    event: 'alert.scored',
    when: {
      all: [
        { field: 'alert.category', op: 'eq', value: 'malware' },
        { field: 'score.score', op: 'gte', value: 60 },
      ],
    },
  },
  start: 'gate',
  steps: [
    { id: 'gate', type: 'approval', with: { prompt: 'ok?' }, next: 'tell' },
    { id: 'tell', type: 'notify', with: { channel: '#c', template: 'x' } },
  ],
});

describe('trigger matching', () => {
  it('matches on alert category and score', () => {
    expect(matchesTrigger(definition, snapshotFixture({ score: 75 }))).toBe(true);
    expect(matchesTrigger(definition, snapshotFixture({ score: 59 }))).toBe(false);
    expect(matchesTrigger(definition, snapshotFixture({ alert: { category: 'phishing' } }))).toBe(
      false,
    );
  });

  it('never matches without a trigger, always matches a trigger without a condition', () => {
    const noTrigger = { ...definition, trigger: undefined };
    expect(matchesTrigger(noTrigger, snapshotFixture())).toBe(false);
    const always = { ...definition, trigger: { event: 'alert.scored' as const } };
    expect(matchesTrigger(always, snapshotFixture())).toBe(true);
  });

  it('treats a condition that throws as not matching', () => {
    const unsafe = {
      ...definition,
      trigger: {
        event: 'alert.scored' as const,
        when: { field: 'alert.title', op: 'matches' as const, value: '(a+)+$' },
      },
    };
    expect(matchesTrigger(unsafe, snapshotFixture())).toBe(false);
  });
});

describe('selectIndicatorsToBlock', () => {
  const enrichments = [
    enrichmentFixture('203.0.113.7', 'ipv4', 'malicious'),
    enrichmentFixture('203.0.113.7', 'ipv4', 'benign', 'other-provider'),
    enrichmentFixture('evil.example', 'domain', 'suspicious'),
  ];

  it('blocks only listed types whose worst verdict meets minVerdict', () => {
    const selection = selectIndicatorsToBlock(alertFixture().indicators, enrichments, {
      indicatorTypes: ['ipv4', 'domain'],
      minVerdict: 'malicious',
    });
    expect(selection.toBlock).toEqual([{ type: 'ipv4', value: '203.0.113.7' }]);
    expect(selection.skipped.map((s) => s.reason)).toEqual([
      'verdict suspicious is below malicious',
      'verdict none is below malicious',
    ]);
  });

  it('accepts suspicious indicators when minVerdict is suspicious, skips unlisted types and duplicates', () => {
    const indicators = [
      ...alertFixture().indicators,
      { type: 'ipv4' as const, value: '203.0.113.7' },
      { type: 'url' as const, value: 'http://evil.example/x' },
    ];
    const selection = selectIndicatorsToBlock(indicators, enrichments, {
      indicatorTypes: ['ipv4', 'domain'],
      minVerdict: 'suspicious',
    });
    expect(selection.toBlock.map((i) => i.value)).toEqual(['203.0.113.7', 'evil.example']);
    expect(selection.skipped.at(-1)?.reason).toBe('type url not in indicatorTypes');
  });
});

describe('approval rules', () => {
  const pending = {
    status: 'pending' as const,
    approverRole: 'analyst' as const,
    expiresAt: '2026-10-28T11:00:00.000Z',
  };
  const now = new Date('2026-10-28T10:00:00.000Z');

  it('allows a pending, unexpired approval for a sufficient role', () => {
    expect(decisionProblem(pending, 'analyst', now)).toBeNull();
    expect(decisionProblem(pending, 'admin', now)).toBeNull();
  });

  it('reports already decided before expired, then expiry, then role', () => {
    expect(
      decisionProblem({ ...pending, status: 'approved' }, 'admin', new Date('2027-01-01')),
    ).toEqual({
      kind: 'already_decided',
      status: 'approved',
    });
    expect(decisionProblem(pending, 'analyst', new Date('2026-10-28T11:00:00.000Z'))).toEqual({
      kind: 'expired',
    });
    expect(decisionProblem({ ...pending, approverRole: 'admin' }, 'analyst', now)).toEqual({
      kind: 'insufficient_role',
      required: 'admin',
    });
  });

  it('maps onTimeout and computes deadlines', () => {
    expect(timeoutOutcome('approve')).toBe('approval.granted');
    expect(timeoutOutcome('reject')).toBe('approval.rejected');
    expect(approvalDeadline(now, 3_600_000)).toBe('2026-10-28T11:00:00.000Z');
  });
});

describe('run views', () => {
  const run = {
    id: '0190f0a0-0000-7000-8000-0000000000aa',
    playbookId: 'demo',
    alertId: alertFixture().id,
    dryRun: false,
  };
  const at = (m: number) => `2026-10-28T10:0${m}:00.000Z`;
  const events: RunEventRecord[] = [
    {
      seq: 1,
      type: 'run.started',
      stepId: null,
      payload: {
        ...snapshotFixture(),
        playbookId: 'demo',
        playbookVersion: 2,
        alertId: run.alertId,
        dryRun: false,
        trigger: 'auto',
        startedBy: null,
      },
      occurredAt: at(0),
    },
    { seq: 2, type: 'step.started', stepId: 'gate', payload: { attempt: 1 }, occurredAt: at(1) },
    {
      seq: 3,
      type: 'approval.requested',
      stepId: 'gate',
      payload: {
        approvalId: '0190f0a0-0000-7000-8000-0000000000ab',
        expiresAt: at(9),
        prompt: 'ok?',
        approverRole: 'analyst',
      },
      occurredAt: at(1),
    },
    {
      seq: 4,
      type: 'approval.granted',
      stepId: 'gate',
      payload: {
        approvalId: '0190f0a0-0000-7000-8000-0000000000ab',
        decidedBy: null,
        reason: 'timeout',
      },
      occurredAt: at(5),
    },
    { seq: 5, type: 'step.started', stepId: 'tell', payload: { attempt: 1 }, occurredAt: at(5) },
    {
      seq: 6,
      type: 'step.failed',
      stepId: 'tell',
      payload: { attempt: 1, error: 'chat down' },
      occurredAt: at(6),
    },
    { seq: 7, type: 'run.failed', stepId: null, payload: {}, occurredAt: at(7) },
  ];

  it('derives per-step states in definition order', () => {
    const steps = toStepStates(definition, reduce(definition, events));
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ['gate', 'succeeded', 1],
      ['tell', 'failed', 1],
    ]);
    expect(steps[1]?.error).toBe('chat down');
    expect(toStepStates(definition, reduce(definition, events.slice(0, 1)))[0]?.status).toBe(
      'pending',
    );
  });

  it('projects status, timestamps and approval wait', () => {
    expect(projectionOf(reduce(definition, events))).toEqual({
      status: 'failed',
      currentStepId: 'tell',
      startedAt: at(1),
      finishedAt: at(7),
      approvalWaitMs: 4 * 60_000,
      lastSeq: 7,
    });
  });

  it('maps appended run events to catalog domain events', () => {
    const state = reduce(definition, events);
    const drafts = domainEventsFor(run, events, state);
    expect(drafts.map((d) => d.type)).toEqual([
      'approval.requested',
      'approval.decided',
      'playbook.run.finished',
    ]);
    expect(drafts[1]?.payload).toMatchObject({ decision: 'expired', decidedBy: null });
    expect(drafts[2]?.payload).toMatchObject({ status: 'failed', durationMs: 7 * 60_000 });
    const rejected = domainEventsFor(
      run,
      [{ ...events[3]!, type: 'approval.rejected', payload: { approvalId: 'x', decidedBy: 'u' } }],
      state,
    );
    expect(rejected[0]?.payload).toMatchObject({ decision: 'rejected', decidedBy: 'u' });
    expect(isTerminalEvent('run.cancelled')).toBe(true);
    expect(isTerminalEvent('step.failed')).toBe(false);
  });
});
