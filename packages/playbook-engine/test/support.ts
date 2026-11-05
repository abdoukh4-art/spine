import {
  PlaybookDefinitionSchema,
  type Alert,
  type PlaybookDefinition,
  type PlaybookDefinitionInput,
} from '@spine/shared-schema';
import { advance } from '../src/executor.js';
import { ConcurrencyError } from '../src/errors.js';
import type {
  AdvanceResult,
  ExecutorPorts,
  LoadedRun,
  RunEventRecord,
  RunStartedPayload,
  RunStore,
  StepContext,
  StepHandler,
  StepHandlers,
} from '../src/types.js';

/** A clock tests can move by hand. */
export class TestClock {
  private ms: number;
  constructor(start = '2026-10-28T10:00:00.000Z') {
    this.ms = Date.parse(start);
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** In-memory {@link RunStore} with the same optimistic-concurrency contract as Postgres. */
export class InMemoryRunStore implements RunStore {
  readonly logs = new Map<string, RunEventRecord[]>();
  readonly definitions = new Map<string, PlaybookDefinition>();
  appendCalls = 0;
  /** Called before each append; throw to simulate a crash or a racing writer. */
  beforeAppend:
    | ((runId: string, expectedSeq: number, events: readonly RunEventRecord[]) => void)
    | null = null;

  create(runId: string, definition: PlaybookDefinition, events: RunEventRecord[]): void {
    this.definitions.set(runId, definition);
    this.logs.set(runId, structuredClone(events));
  }

  load(runId: string): Promise<LoadedRun | null> {
    const definition = this.definitions.get(runId);
    const events = this.logs.get(runId);
    if (!definition || !events) return Promise.resolve(null);
    return Promise.resolve({ definition, events: structuredClone(events) });
  }

  append(runId: string, expectedSeq: number, events: readonly RunEventRecord[]): Promise<void> {
    this.appendCalls += 1;
    this.beforeAppend?.(runId, expectedSeq, events);
    const log = this.logs.get(runId);
    if (!log) return Promise.reject(new Error(`no run ${runId}`));
    if ((log.at(-1)?.seq ?? 0) !== expectedSeq) {
      return Promise.reject(new ConcurrencyError(runId, expectedSeq));
    }
    log.push(...structuredClone([...events]));
    return Promise.resolve();
  }

  events(runId: string): RunEventRecord[] {
    return this.logs.get(runId) ?? [];
  }
}

export const RUN_ID = '00000000-0000-7000-8000-0000000000aa';

/** A valid alert snapshot. */
export function testAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    fingerprint: 'f'.repeat(64),
    status: 'new',
    source: { vendor: 'Acme', product: 'EDR' },
    title: 'Mimikatz detected',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-10-28T09:00:00.000Z',
    receivedAt: '2026-10-28T09:00:01.000Z',
    lastSeenAt: '2026-10-28T09:00:01.000Z',
    duplicateCount: 0,
    indicators: [{ type: 'ipv4', value: '203.0.113.7' }],
    mitre: [],
    labels: {},
    ...overrides,
  };
}

/** Parses a definition input with defaults applied (throws on schema errors). */
export function definition(
  input: Omit<PlaybookDefinitionInput, 'apiVersion' | 'kind' | 'metadata'> & {
    metadata?: PlaybookDefinitionInput['metadata'];
  },
): PlaybookDefinition {
  return PlaybookDefinitionSchema.parse({
    apiVersion: 'spine/v1',
    kind: 'Playbook',
    metadata: { id: 'test-playbook', name: 'Test', version: 1 },
    ...input,
  });
}

/** The `run.started` event for a run. */
export function runStarted(
  def: PlaybookDefinition,
  options: { dryRun?: boolean; alert?: Alert; at?: string } = {},
): RunEventRecord {
  const alert = options.alert ?? testAlert();
  const payload: RunStartedPayload = {
    playbookId: def.metadata.id,
    playbookVersion: def.metadata.version,
    alertId: alert.id,
    dryRun: options.dryRun ?? false,
    trigger: 'manual',
    startedBy: null,
    alert,
    score: null,
    enrichments: [],
  };
  return {
    seq: 1,
    type: 'run.started',
    stepId: null,
    payload: payload as unknown as Record<string, unknown>,
    occurredAt: options.at ?? '2026-10-28T10:00:00.000Z',
  };
}

/** One recorded handler invocation. */
export interface Call {
  stepId: string;
  type: string;
  key: string;
  dryRun: boolean;
  phase: 'execute' | 'compensate';
}

/**
 * A handler registry that records every call. `behaviour(stepId, attempt)` may throw to
 * simulate failures; it returns the output otherwise.
 */
export function recordingHandlers(
  calls: Call[],
  behaviour: (stepId: string, ctx: StepContext) => unknown = (stepId) => ({ done: stepId }),
  compensateBehaviour: (stepId: string) => unknown = (stepId) => ({ undone: stepId }),
): StepHandlers {
  const handler: StepHandler = {
    execute: (step, ctx) => {
      calls.push({
        stepId: step.id,
        type: step.type,
        key: ctx.idempotencyKey,
        dryRun: ctx.dryRun,
        phase: 'execute',
      });
      if (step.type === 'approval') {
        return Promise.resolve({
          approvalId: `approval-${step.id}`,
          expiresAt: '2026-10-28T11:00:00.000Z',
          prompt: 'ok?',
        });
      }
      try {
        return Promise.resolve(behaviour(step.id, ctx));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    compensate: (step, ctx) => {
      calls.push({
        stepId: step.id,
        type: step.type,
        key: ctx.idempotencyKey,
        dryRun: ctx.dryRun,
        phase: 'compensate',
      });
      try {
        return Promise.resolve(compensateBehaviour(step.id));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
  return {
    enrich: handler,
    score: handler,
    notify: handler,
    create_ticket: handler,
    block_indicator: handler,
    set_status: handler,
    approval: handler,
  };
}

/** Result of {@link drive}. */
export interface DriveResult {
  last: AdvanceResult;
  advances: number;
}

/**
 * Drives a run to a terminal state like a host would: answers approvals from `decisions`
 * (default: approve) and lets retry delays elapse by moving the clock.
 */
export async function drive(
  store: InMemoryRunStore,
  runId: string,
  ports: Omit<ExecutorPorts, 'store'> & { clock: TestClock },
  decisions: Record<string, 'approve' | 'reject'> = {},
): Promise<DriveResult> {
  for (let advances = 1; advances <= 100; advances += 1) {
    const last = await advance(runId, { ...ports, store });
    const outcome = last.outcome;
    if (outcome.kind === 'waiting_approval') {
      const stepId = store.events(runId).at(-1)?.stepId ?? '';
      const approve = (decisions[stepId] ?? 'approve') === 'approve';
      await store.append(runId, last.lastSeq, [
        {
          seq: last.lastSeq + 1,
          type: approve ? 'approval.granted' : 'approval.rejected',
          stepId,
          payload: { approvalId: outcome.approvalId, decidedBy: null, reason: 'decision' },
          occurredAt: ports.clock.now().toISOString(),
        },
      ]);
      continue;
    }
    if (outcome.kind === 'retry_scheduled') {
      ports.clock.advance(outcome.delayMs);
      continue;
    }
    if (outcome.kind === 'yielded') continue;
    return { last, advances };
  }
  throw new Error('run did not terminate within 100 advances');
}

/** The (type, stepId) sequence of a log — handy for exact timeline assertions. */
export function timeline(events: readonly RunEventRecord[]): string[] {
  return events.map((e) => (e.stepId ? `${e.type}:${e.stepId}` : e.type));
}
