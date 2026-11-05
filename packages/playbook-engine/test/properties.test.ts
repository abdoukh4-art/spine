import type { PlaybookDefinition } from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance, idempotencyKey } from '../src/executor.js';
import { applyEvent, initialRunState, reduce } from '../src/reduce.js';
import type { RunEventRecord } from '../src/types.js';
import { validatePlaybook } from '../src/validate.js';
import {
  drive,
  InMemoryRunStore,
  recordingHandlers,
  RUN_ID,
  runStarted,
  testAlert,
  TestClock,
  type Call,
} from './support.js';

/**
 * Property-based tests (ADR-0021). Each property states an invariant of the engine and
 * fast-check searches for a counter-example among hundreds of random playbooks.
 * On failure, fast-check prints the seed and the shrunk counter-example.
 */

type Kind = 'task' | 'branch' | 'approval' | 'block';
interface Spec {
  kinds: Kind[];
  seeds: number[][];
  onReject: boolean[];
  thresholds: number[];
  order: number[];
}

const id = (i: number) => `s${i}`;

/** Forward-only edges (i → j with j > i) make the graph acyclic; i → i+1 makes it connected. */
function target(i: number, n: number, seed: number): number {
  return i + 1 + (seed % (n - 1 - i));
}

function buildStep(spec: Spec, i: number, n: number): Record<string, unknown> {
  const last = i === n - 1;
  const kind = spec.kinds[i] === 'branch' && last ? 'task' : spec.kinds[i];
  const seeds = spec.seeds[i] ?? [0];
  const next = last ? {} : { next: id(i + 1) };
  switch (kind) {
    case 'branch':
      return {
        id: id(i),
        type: 'branch',
        branches: seeds.map((seed, k) => ({
          when: { field: 'alert.duplicateCount', op: 'gte', value: (spec.thresholds[i] ?? 0) + k },
          next: id(target(i, n, seed)),
        })),
        default: id(i + 1),
      };
    case 'approval':
      return {
        id: id(i),
        type: 'approval',
        with: { prompt: 'ok?' },
        ...next,
        ...(spec.onReject[i] && !last ? { onReject: id(target(i, n, seeds[0] ?? 0)) } : {}),
      };
    case 'block':
      return {
        id: id(i),
        type: 'block_indicator',
        with: {},
        compensate: { type: 'unblock_indicator' },
        ...next,
      };
    default:
      return { id: id(i), type: 'notify', with: { channel: '#c', template: 't' }, ...next };
  }
}

function buildRaw(spec: Spec): {
  apiVersion: string;
  kind: string;
  metadata: object;
  start: string;
  steps: Record<string, unknown>[];
} {
  const n = spec.kinds.length;
  const steps = spec.order.map((i) => buildStep(spec, i, n));
  return {
    apiVersion: 'spine/v1',
    kind: 'Playbook',
    metadata: { id: 'prop', name: 'Prop', version: 1 },
    start: 's0',
    steps,
  };
}

const specArb: fc.Arbitrary<Spec> = fc.integer({ min: 1, max: 9 }).chain((n) =>
  fc.record({
    kinds: fc.array(fc.constantFrom<Kind>('task', 'branch', 'approval', 'block'), {
      minLength: n,
      maxLength: n,
    }),
    seeds: fc.array(fc.array(fc.nat(50), { minLength: 1, maxLength: 3 }), {
      minLength: n,
      maxLength: n,
    }),
    onReject: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    thresholds: fc.array(fc.nat(5), { minLength: n, maxLength: n }),
    order: fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n }),
  }),
);

function parsed(spec: Spec): PlaybookDefinition {
  const result = validatePlaybook(buildRaw(spec));
  if (!result.valid) throw new Error(JSON.stringify(result.errors));
  return result.definition;
}

/** Independent oracle: walks the graph the way the engine should. */
function expectedPath(
  def: PlaybookDefinition,
  dupCount: number,
  decisions: Record<string, 'approve' | 'reject'>,
): string[] {
  const path: string[] = [];
  let current: string | undefined = def.start;
  while (current !== undefined) {
    const step = def.steps.find((s) => s.id === current);
    if (!step) throw new Error('oracle lost');
    path.push(step.id);
    if (step.type === 'branch') {
      const hit = step.branches.find((b) => 'field' in b.when && dupCount >= Number(b.when.value));
      current = hit?.next ?? step.default;
    } else if (step.type === 'approval') {
      current = (decisions[step.id] ?? 'approve') === 'approve' ? step.next : step.onReject;
    } else {
      current = step.next;
    }
  }
  return path;
}

const runArb = fc.record({
  spec: specArb,
  dupCount: fc.nat(8),
  rejects: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
});

function decisionsFor(
  def: PlaybookDefinition,
  rejects: boolean[],
): Record<string, 'approve' | 'reject'> {
  const out: Record<string, 'approve' | 'reject'> = {};
  def.steps.forEach((s) => {
    out[s.id] = rejects[Number(s.id.slice(1))] ? 'reject' : 'approve';
  });
  return out;
}

function newRun(
  def: PlaybookDefinition,
  dupCount: number,
  events?: RunEventRecord[],
): InMemoryRunStore {
  const store = new InMemoryRunStore();
  store.create(
    RUN_ID,
    def,
    events ?? [runStarted(def, { alert: testAlert({ duplicateCount: dupCount }) })],
  );
  return store;
}

async function reference(
  def: PlaybookDefinition,
  dupCount: number,
  decisions: Record<string, 'approve' | 'reject'>,
) {
  const store = newRun(def, dupCount);
  const calls: Call[] = [];
  const clock = new TestClock();
  const driven = await drive(
    store,
    RUN_ID,
    { clock, handlers: recordingHandlers(calls) },
    decisions,
  );
  return { store, calls, driven, log: store.events(RUN_ID) };
}

describe('property: validation', () => {
  it('accepts every generated acyclic, connected playbook', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const result = validatePlaybook(buildRaw(spec));
        expect(result.valid ? [] : result.errors).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects any back-edge mutation with a cycle error', () => {
    const arb = specArb
      .filter((s) => s.kinds.length >= 2)
      .chain((spec) =>
        fc.record({
          spec: fc.constant(spec),
          j: fc.integer({ min: 0, max: spec.kinds.length - 1 }),
          i: fc.nat(),
        }),
      );
    fc.assert(
      fc.property(arb, ({ spec, j, i }) => {
        const raw = buildRaw(spec);
        const back = id(i % (j + 1)); // some node at or before j: it reaches j through i → i+1 → …
        const step = raw.steps.find((s) => s.id === id(j))!;
        if (step.type === 'branch')
          (step.branches as object[]).push({ when: { field: 'a', op: 'exists' }, next: back });
        else step.next = back;
        const result = validatePlaybook(raw);
        expect(result.valid).toBe(false);
        if (!result.valid)
          expect(result.errors.some((e) => e.message.startsWith('cycle detected'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects any dangling reference and points at the offending field', () => {
    const arb = specArb.chain((spec) =>
      fc.record({ spec: fc.constant(spec), k: fc.nat(spec.kinds.length - 1) }),
    );
    fc.assert(
      fc.property(arb, ({ spec, k }) => {
        const raw = buildRaw(spec);
        const index = raw.steps.findIndex((s) => s.id === id(k));
        const step = raw.steps[index]!;
        let path = `steps[${index}].next`;
        if (step.type === 'branch') {
          step.default = 'ghost';
          path = `steps[${index}].default`;
        } else step.next = 'ghost';
        const result = validatePlaybook(raw);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors).toContainEqual({
            path,
            message: 'references unknown step "ghost"',
          });
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('property: execution', () => {
  it('with succeeding handlers, terminates succeeded and runs each step on the taken path exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async ({ spec, dupCount, rejects }) => {
        const def = parsed(spec);
        const decisions = decisionsFor(def, rejects);
        const { calls, driven, log } = await reference(def, dupCount, decisions);
        const path = expectedPath(def, dupCount, decisions);
        const handled = path.filter((s) => def.steps.find((d) => d.id === s)?.type !== 'branch');

        expect(driven.last.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
        expect(calls.map((c) => c.stepId)).toEqual(handled);
        const approvals = path.filter(
          (s) => def.steps.find((d) => d.id === s)?.type === 'approval',
        );
        // Bounded work: one advance per human decision plus the final one, and a bounded loop each.
        expect(driven.advances).toBe(approvals.length + 1);
        expect(log.length).toBeLessThanOrEqual(2 + 3 * path.length);
      }),
      { numRuns: 200 },
    );
  });

  it('crash-resume: truncating the log anywhere and resuming yields the same log, same keys, no re-run of completed steps', async () => {
    const arb = runArb.chain((r) => fc.record({ run: fc.constant(r), cut: fc.nat(200) }));
    await fc.assert(
      fc.asyncProperty(arb, async ({ run, cut }) => {
        const def = parsed(run.spec);
        const decisions = decisionsFor(def, run.rejects);
        const ref = await reference(def, run.dupCount, decisions);
        const keyOf = new Map(ref.calls.map((c) => [c.stepId, c.key]));

        const k = 1 + (cut % ref.log.length);
        const prefix = ref.log.slice(0, k);
        const store = newRun(def, run.dupCount, prefix);
        const calls: Call[] = [];
        await drive(
          store,
          RUN_ID,
          { clock: new TestClock(), handlers: recordingHandlers(calls) },
          decisions,
        );

        expect(store.events(RUN_ID)).toEqual(ref.log);
        const finished = new Set(
          prefix
            .filter((e) => e.type === 'step.succeeded' || e.type === 'approval.requested')
            .map((e) => e.stepId),
        );
        for (const call of calls) {
          expect(finished.has(call.stepId)).toBe(false);
          expect(call.key).toBe(keyOf.get(call.stepId));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('crash-resume: a crash at any append never runs a step under two different keys', async () => {
    const arb = runArb.chain((r) =>
      fc.record({ run: fc.constant(r), crashAt: fc.integer({ min: 1, max: 40 }) }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ run, crashAt }) => {
        const def = parsed(run.spec);
        const decisions = decisionsFor(def, run.rejects);
        const ref = await reference(def, run.dupCount, decisions);

        const store = newRun(def, run.dupCount);
        const calls: Call[] = [];
        const ports = { clock: new TestClock(), handlers: recordingHandlers(calls) };
        let appends = 0;
        store.beforeAppend = () => {
          appends += 1;
          if (appends === crashAt) throw new Error('💥 worker crashed');
        };
        await drive(store, RUN_ID, ports, decisions).catch((err: unknown) => {
          if (!(err instanceof Error) || !err.message.includes('crashed')) throw err;
        });
        store.beforeAppend = null;
        await drive(store, RUN_ID, ports, decisions);

        expect(store.events(RUN_ID)).toEqual(ref.log);
        const keys = new Map<string, Set<string>>();
        for (const c of calls) keys.set(c.stepId, (keys.get(c.stepId) ?? new Set()).add(c.key));
        for (const [stepId, set] of keys)
          expect([...set]).toEqual([idempotencyKey(RUN_ID, stepId, 1)]);
      }),
      { numRuns: 200 },
    );
  });

  it('reduce is deterministic: replaying the same events (even after a JSON round-trip) gives the same state', async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async ({ spec, dupCount, rejects }) => {
        const def = parsed(spec);
        const { log } = await reference(def, dupCount, decisionsFor(def, rejects));
        const once = reduce(def, log);
        expect(reduce(def, log)).toEqual(once);
        expect(reduce(def, JSON.parse(JSON.stringify(log)) as RunEventRecord[])).toEqual(once);
        expect(log.reduce((s, e) => applyEvent(def, s, e), initialRunState(def))).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });

  it('with a failing step, compensation runs in exact reverse order of completion', async () => {
    const arb = fc.integer({ min: 1, max: 8 }).chain((n) =>
      fc.record({
        blocks: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
        failAt: fc.nat(n - 1),
      }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ blocks, failAt }) => {
        const n = blocks.length;
        const kinds: Kind[] = blocks.map((b) => (b ? 'block' : 'task'));
        const spec: Spec = {
          kinds,
          seeds: kinds.map(() => [0]),
          onReject: kinds.map(() => false),
          thresholds: kinds.map(() => 0),
          order: [...Array(n).keys()],
        };
        const def = parsed(spec);
        const store = newRun(def, 0);
        const calls: Call[] = [];
        const handlers = recordingHandlers(calls, (stepId) => {
          if (stepId === id(failAt)) throw new Error('boom');
          return { ok: stepId };
        });
        const result = await advance(RUN_ID, { store, clock: new TestClock(), handlers });

        const completed = [...Array(failAt).keys()].map(id);
        const expected = completed.filter((s) => blocks[Number(s.slice(1))]).reverse();
        expect(calls.filter((c) => c.phase === 'compensate').map((c) => c.stepId)).toEqual(
          expected,
        );
        expect(result.outcome).toEqual({
          kind: 'terminal',
          status: expected.length > 0 ? 'compensated' : 'failed',
        });
      }),
      { numRuns: 200 },
    );
  });
});
