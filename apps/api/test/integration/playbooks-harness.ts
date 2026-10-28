import path from 'node:path';
import type { AdvanceResult, RunSnapshot } from '@spine/playbook-engine';
import type { AlertStatus, DomainEvent, EventType, Role } from '@spine/shared-schema';
import { pino } from 'pino';
import { InlineDeliveryQueue } from '../../src/platform/events/in-memory.js';
import { OutboxEventPublisher, OutboxRelay } from '../../src/platform/events/outbox.js';
import { EventSubscriptions } from '../../src/platform/events/types.js';
import { UnauthenticatedError } from '../../src/platform/errors.js';
import type { Authenticator } from '../../src/platform/http/access.js';
import { buildHttpServer } from '../../src/platform/http/server.js';
import { ManualClock, uuidV7Generator } from '../../src/platform/runtime.js';
import type {
  AuditGateway,
  ResponseActions,
  RunQueue,
} from '../../src/modules/playbooks/application/ports.js';
import { createSimulatedIntegrations } from '../../src/modules/playbooks/adapters/simulated/integrations.js';
import { SimulatedActionRecorder } from '../../src/modules/playbooks/adapters/simulated/recorder.js';
import { readPlaybookSources } from '../../src/modules/playbooks/adapters/tasks.js';
import { createPlaybooksModule, type PlaybooksModule } from '../../src/modules/playbooks/index.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { alertFixture, enrichmentFixture, scoreFixture } from '../unit/playbooks/fixtures.js';

/** Records enqueues instead of talking to Redis. */
export class RecordingRunQueue implements RunQueue {
  readonly jobs: { runId: string; seq: number; delayMs?: number }[] = [];
  enqueue(
    runId: string,
    seq: number,
    options?: { delayMs: number; notBefore: string },
  ): Promise<void> {
    this.jobs.push({ runId, seq, ...(options ? { delayMs: options.delayMs } : {}) });
    return Promise.resolve();
  }
}

export const USERS: Record<string, { id: string; role: Role }> = {
  'viewer-token': { id: '0190f0a0-0000-7000-8000-00000000000a', role: 'viewer' },
  'analyst-token': { id: '0190f0a0-0000-7000-8000-00000000000b', role: 'analyst' },
  'admin-token': { id: '0190f0a0-0000-7000-8000-00000000000c', role: 'admin' },
};

const authenticator: Authenticator = {
  authenticate: (token) => {
    const user = USERS[token];
    if (!user) return Promise.reject(new UnauthenticatedError('bad token'));
    return Promise.resolve({
      kind: 'user',
      id: user.id,
      role: user.role,
      email: `${user.role}@spine.test`,
    });
  },
};

/** Fault-injection controls shared with the simulated adapters. */
export interface FaultControls {
  failureRateByKind: Record<string, number>;
  randoms: number[];
  /** When true, the audit gateway throws (to prove decisions roll back with their audit). */
  auditFails?: boolean;
}

export interface Harness {
  t: TestDatabase;
  pb: PlaybooksModule;
  clock: ManualClock;
  queue: RecordingRunQueue;
  snapshots: Map<string, RunSnapshot>;
  statusChanges: [string, AlertStatus][];
  audits: Parameters<AuditGateway['record']>[0][];
  faults: FaultControls;
  relay: OutboxRelay;
  /** The simulated integrations, for applying side effects "behind the engine's back". */
  real: ResponseActions;
  /** Publishes a domain event through the outbox, as the producing module would. */
  publish<T extends EventType>(
    type: T,
    aggregateId: string,
    payload: DomainEvent<T>['payload'],
  ): Promise<void>;
  /** Dispatches the outbox until it is empty (subscribers run inline). */
  drainOutbox(): Promise<void>;
  /** Advances a run like the worker would, letting retry delays elapse, until it stops waiting on time. */
  run(runId: string): Promise<AdvanceResult>;
  /** Registers an alert snapshot and returns it. */
  alert(options?: { category?: string; score?: number; malicious?: boolean }): RunSnapshot;
  destroy(): Promise<void>;
}

/** Builds the playbooks module on a fresh schema with fake gateways and seeded playbooks. */
export async function createHarness(
  options: { actions?: (real: ResponseActions) => ResponseActions; queue?: RunQueue } = {},
): Promise<Harness> {
  const t = await createTestDatabase();
  const clock = new ManualClock('2026-10-28T10:00:00.000Z');
  const ids = uuidV7Generator;
  const logger = pino({ level: 'silent' });
  const events = new OutboxEventPublisher(ids, clock);
  const config = testConfig({
    SIMULATION_LATENCY_MS: '0',
    CONFIG_DIR: path.resolve(import.meta.dirname, '../../config'),
  });
  const queue = new RecordingRunQueue();
  const snapshots = new Map<string, RunSnapshot>();
  const statusChanges: [string, AlertStatus][] = [];
  const audits: Harness['audits'] = [];
  const faults: FaultControls = { failureRateByKind: {}, randoms: [] };

  const deps = { config, logger, db: t.db, clock, ids, events, redis: null };
  const real = createSimulatedIntegrations(
    new SimulatedActionRecorder(t.db, ids, clock, simulation()),
    clock,
  );
  const pb = createPlaybooksModule(deps, gateways(), {
    queue: options.queue ?? queue,
    simulation: simulation(),
    ...(options.actions ? { actions: options.actions(real) } : {}),
  });
  await pb.catalog.seed(await readPlaybookSources(path.join(config.CONFIG_DIR, 'playbooks')));

  const subscriptions = new EventSubscriptions();
  for (const handler of pb.module.subscribers?.() ?? []) subscriptions.register(handler);
  const relay = new OutboxRelay(
    t.db,
    subscriptions,
    new InlineDeliveryQueue(subscriptions, logger),
    logger,
    {
      pollIntervalMs: 10,
      batchSize: 100,
    },
  );

  function simulation() {
    return {
      latencyMs: 0,
      failureRate: 0,
      failureRateByKind: faults.failureRateByKind,
      random: () => faults.randoms.shift() ?? 0.99,
    };
  }

  function gateways() {
    return {
      enrichment: {
        enrich: (alert: { id: string }) =>
          Promise.resolve(snapshots.get(alert.id)?.enrichments ?? []),
      },
      scoring: { score: () => Promise.resolve(null) },
      alertStatus: {
        setStatus: (alertId: string, status: AlertStatus) => {
          statusChanges.push([alertId, status]);
          return Promise.resolve({ changed: true });
        },
      },
      alertSnapshot: { get: (alertId: string) => Promise.resolve(snapshots.get(alertId) ?? null) },
      audit: {
        record: (entry: Parameters<AuditGateway['record']>[0]) => {
          if (faults.auditFails) return Promise.reject(new Error('audit store unavailable'));
          audits.push(entry);
          return Promise.resolve();
        },
      },
    };
  }

  const harness: Harness = {
    t,
    pb,
    clock,
    queue,
    snapshots,
    statusChanges,
    audits,
    faults,
    relay,
    real,
    async publish(type, aggregateId, payload) {
      await events.publish(t.db, [{ type, aggregateId, payload } as never]);
    },
    async drainOutbox() {
      while ((await relay.dispatchBatch()) > 0) {
        /* keep draining */
      }
    },
    async run(runId) {
      for (let i = 0; i < 50; i += 1) {
        const result = await pb.executor.advanceRun(runId);
        if (result.outcome.kind === 'retry_scheduled') {
          clock.advance(result.outcome.delayMs);
          continue;
        }
        if (result.outcome.kind === 'yielded') continue;
        return result;
      }
      throw new Error('run did not settle');
    },
    alert(opts = {}) {
      const alert = alertFixture({
        id: ids.next(),
        category: (opts.category ?? 'malware') as never,
      });
      const snapshot: RunSnapshot = {
        alert,
        score: scoreFixture(opts.score ?? 90),
        enrichments: [
          enrichmentFixture(
            '203.0.113.7',
            'ipv4',
            opts.malicious === false ? 'benign' : 'malicious',
          ),
          enrichmentFixture('evil.example', 'domain', 'suspicious'),
        ],
      };
      snapshots.set(alert.id, snapshot);
      return snapshot;
    },
    destroy: () => t.destroy(),
  };
  return harness;
}

/** Builds a Fastify server exposing only the playbooks module, with fake tokens. */
export function buildServer(pb: PlaybooksModule) {
  return buildHttpServer({
    config: testConfig(),
    modules: [pb.module],
    authenticator,
    redis: null,
    logger: false,
    readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
  });
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
