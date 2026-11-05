import type { EnrichmentResult } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import { buildEvaluationContext, summarizeEnrichment, verdictRank } from '../src/context.js';
import { decide, retryDelayMs, MAX_RETRY_DELAY_MS } from '../src/decide.js';
import { RunStateError } from '../src/errors.js';
import { applyEvent, initialRunState, reduce } from '../src/reduce.js';
import type { RunEventRecord } from '../src/types.js';
import { definition, RUN_ID, runStarted, testAlert } from './support.js';

const def = definition({
  start: 'gate',
  steps: [
    { id: 'gate', type: 'approval', with: { prompt: 'ok?' }, next: 'enrich' },
    { id: 'enrich', type: 'enrich', next: 'score' },
    { id: 'score', type: 'score' },
  ],
});
const at = (minute: number) => `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`;
function ev(
  seq: number,
  type: RunEventRecord['type'],
  stepId: string | null,
  payload = {},
  minute = seq,
): RunEventRecord {
  return { seq, type, stepId, payload, occurredAt: at(minute) };
}
const now = { now: new Date(at(30)) };

const result = (
  verdict: EnrichmentResult['verdict'],
  type: 'url' | 'ipv4',
  value: string,
): EnrichmentResult => ({
  provider: 'rep',
  indicator: { type, value },
  status: 'ok',
  ...(verdict ? { verdict } : {}),
  durationMs: 1,
  fetchedAt: at(0),
});

describe('reduce', () => {
  it('derives status, timestamps and approval wait time from the events', () => {
    const events = [
      runStarted(def, { at: at(0) }),
      ev(2, 'step.started', 'gate', { attempt: 1 }),
      ev(3, 'approval.requested', 'gate', { approvalId: 'ap-1', expiresAt: at(59) }),
    ];
    const waiting = reduce(def, events);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.pendingApproval).toEqual({
      stepId: 'gate',
      approvalId: 'ap-1',
      expiresAt: at(59),
      requestedAt: at(3),
    });
    expect(decide(def, waiting, now)).toEqual({
      kind: 'WaitForApproval',
      stepId: 'gate',
      approvalId: 'ap-1',
      expiresAt: at(59),
    });

    const granted = reduce(def, [
      ...events,
      ev(4, 'approval.granted', 'gate', { approvalId: 'ap-1' }, 13),
    ]);
    expect(granted.status).toBe('running');
    expect(granted.approvalWaitMs).toBe(10 * 60_000);
    expect(granted.currentStepId).toBe('enrich');
    expect(granted.steps.gate?.output).toEqual({ approvalId: 'ap-1', decision: 'approved' });
    expect(granted.startedAt).toBe(at(2));
  });

  it('starts pending, and a run.started-only log points at the start step', () => {
    const state = reduce(def, [runStarted(def)]);
    expect(state.status).toBe('pending');
    expect(state.currentStepId).toBe('gate');
    expect(decide(def, state, now)).toEqual({ kind: 'RequestApproval', stepId: 'gate' });
  });

  it('rejects gaps in the sequence, events before run.started and unknown steps', () => {
    expect(() => reduce(def, [runStarted(def), ev(3, 'step.started', 'gate')])).toThrow(
      RunStateError,
    );
    expect(() => reduce(def, [ev(1, 'step.started', 'gate')])).toThrow(/before run.started/);
    expect(() => reduce(def, [runStarted(def), ev(2, 'step.started', 'ghost')])).toThrow(
      /unknown step/,
    );
    expect(() =>
      reduce(def, [runStarted(def), ev(2, 'nonsense' as RunEventRecord['type'], 'gate')]),
    ).toThrow(/unexpected event type/);
  });

  it('applyEvent does not mutate its input', () => {
    const initial = initialRunState(def);
    const next = applyEvent(def, initial, runStarted(def));
    expect(initial.lastSeq).toBe(0);
    expect(next.lastSeq).toBe(1);
  });

  it('marks terminal events and clears the pending approval', () => {
    const state = reduce(def, [
      runStarted(def),
      ev(2, 'step.started', 'gate', { attempt: 1 }),
      ev(3, 'approval.requested', 'gate', { approvalId: 'a', expiresAt: at(9) }),
      ev(4, 'run.cancelled', null),
    ]);
    expect(state.status).toBe('cancelled');
    expect(state.pendingApproval).toBeNull();
    expect(state.finishedAt).toBe(at(4));
    expect(decide(def, state, now)).toEqual({ kind: 'Halt', status: 'cancelled' });
  });

  it('defaults malformed payload fields instead of crashing', () => {
    const state = reduce(def, [
      runStarted(def),
      ev(2, 'step.skipped', 'gate', {}),
      ev(3, 'step.started', 'enrich', { attempt: 'x' }),
      ev(4, 'step.failed', 'enrich', { error: 42 }),
    ]);
    expect(state.steps.enrich?.attempts).toBe(1);
    expect(state.steps.enrich?.error).toBe('unknown error');
    expect(state.failure).toEqual({ stepId: 'enrich', error: 'unknown error' });
  });
});

describe('decide — guards', () => {
  it('throws on states that contradict the definition', () => {
    expect(() => decide(def, initialRunState(def), now)).toThrow(/no run.started/);
    const waitingForNothing = reduce(def, [runStarted(def)]);
    waitingForNothing.steps.gate!.status = 'waiting';
    expect(() => decide(def, waitingForNothing, now)).toThrow(/waits for nothing/);
    const done = reduce(def, [runStarted(def)]);
    done.steps.gate!.status = 'succeeded';
    expect(() => decide(def, done, now)).toThrow(/already succeeded/);
    const lost = reduce(def, [runStarted(def)]);
    lost.currentStepId = 'ghost';
    expect(() => decide(def, lost, now)).toThrow(/not in the definition/);
  });

  it('re-requests an approval whose request was started but not recorded', () => {
    const state = reduce(def, [runStarted(def), ev(2, 'step.started', 'gate', { attempt: 1 })]);
    expect(decide(def, state, now)).toEqual({ kind: 'RequestApproval', stepId: 'gate' });
  });

  it('caps exponential backoff', () => {
    const step = def.steps[1]!;
    expect(retryDelayMs(step, 1)).toBe(1000);
    expect(retryDelayMs(step, 3)).toBe(4000);
    expect(retryDelayMs(step, 30)).toBe(MAX_RETRY_DELAY_MS);
  });
});

describe('evaluation context', () => {
  it('summarizes verdicts per type and the worst verdict per indicator', () => {
    const summary = summarizeEnrichment([
      result('malicious', 'url', 'http://evil.test/x'),
      result('benign', 'url', 'http://good.test'),
      result('suspicious', 'ipv4', '198.51.100.1'),
      result('benign', 'ipv4', '198.51.100.1'),
      result(undefined, 'ipv4', '198.51.100.2'),
    ]);
    expect(summary.verdicts).toEqual({
      url: ['malicious', 'benign'],
      ipv4: ['suspicious', 'benign'],
    });
    expect(summary.malicious).toEqual(['http://evil.test/x']);
    expect(summary.suspicious).toEqual(['198.51.100.1']);
    expect(verdictRank(undefined)).toBe(-1);
    expect(verdictRank('weird')).toBe(1);
  });

  it('refreshes enrichment and score from enrich/score step outputs', () => {
    const score = {
      score: 91,
      rawScore: 91,
      severity: 'critical',
      rulesetVersion: 1,
      factors: [],
      dataGaps: [],
      computedAt: at(0),
    };
    const state = reduce(def, [
      runStarted(def, { alert: testAlert({ title: 'T' }) }),
      ev(2, 'step.skipped', 'gate', {}),
      ev(3, 'step.started', 'enrich', { attempt: 1 }),
      ev(4, 'step.succeeded', 'enrich', {
        output: { enrichments: [result('malicious', 'ipv4', '203.0.113.7')] },
      }),
      ev(5, 'step.started', 'score', { attempt: 1 }),
      ev(6, 'step.succeeded', 'score', { output: { score } }),
    ]);
    const ctx = buildEvaluationContext(RUN_ID, state);
    expect(ctx.alert?.title).toBe('T');
    expect(ctx.score?.score).toBe(91);
    expect(ctx.enrichment.malicious).toEqual(['203.0.113.7']);
    expect(Object.keys(ctx.steps)).toEqual(['enrich', 'score']);
    expect(ctx.run).toMatchObject({ id: RUN_ID, playbookId: 'test-playbook', dryRun: false });
    expect(decide(def, state, now)).toEqual({ kind: 'Finish', status: 'succeeded' });
  });

  it('builds an empty context for an empty state', () => {
    const ctx = buildEvaluationContext(RUN_ID, initialRunState(def));
    expect(ctx).toMatchObject({
      alert: null,
      score: null,
      run: { playbookId: '', playbookVersion: 0 },
    });
  });
});
