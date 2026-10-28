import path from 'node:path';
import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { ApprovalService } from './application/approvals.js';
import { PlaybookCatalog } from './application/catalog.js';
import { RunExecutor } from './application/executor.js';
import type { PlaybooksGateways, ResponseActions, RunQueue } from './application/ports.js';
import { RunService } from './application/runs.js';
import { createStepHandlers } from './application/step-handlers.js';
import { playbookSubscribers } from './adapters/events/subscribers.js';
import { registerPlaybookRoutes } from './adapters/http/routes.js';
import { PlaybookMetrics } from './adapters/metrics.js';
import { PostgresPlaybooksStore } from './adapters/postgres/store.js';
import { BullMqRunQueue, NoopRunQueue, RunWorkerTask } from './adapters/queue/run-queue.js';
import { createSimulatedIntegrations } from './adapters/simulated/integrations.js';
import { SimulatedActionRecorder, type SimulationOptions } from './adapters/simulated/recorder.js';
import { ApprovalExpiryTask, PlaybookSeedTask, RunReconcilerTask } from './adapters/tasks.js';
import type { PlaybooksPublicApi } from './public-api.js';

/** Optional overrides, mainly for tests (fault injection, a fake queue). */
export interface PlaybooksModuleOptions {
  queue?: RunQueue;
  simulation?: Partial<SimulationOptions>;
  /** Replaces the simulated integrations entirely. */
  actions?: ResponseActions;
}

/** Everything the module builds, exposed for the worker and for tests. */
export interface PlaybooksModule {
  module: SpineModule;
  api: PlaybooksPublicApi;
  catalog: PlaybookCatalog;
  runs: RunService;
  approvals: ApprovalService;
  executor: RunExecutor;
  store: PostgresPlaybooksStore;
  queue: RunQueue;
}

/**
 * Playbooks module composition (ADR-0002): builds adapters, injects them into the use cases
 * and contributes routes, subscribers and background tasks to the platform.
 * @param gateways ports onto other modules, wired by `composition.ts`.
 */
export function createPlaybooksModule(
  deps: PlatformDeps,
  gateways: PlaybooksGateways,
  options: PlaybooksModuleOptions = {},
): PlaybooksModule {
  const { config, logger, clock, ids } = deps;
  const recorder = new SimulatedActionRecorder(deps.db, ids, clock, {
    latencyMs: config.SIMULATION_LATENCY_MS,
    failureRate: config.SIMULATION_FAILURE_RATE,
    ...options.simulation,
  });
  let metrics: PlaybookMetrics | null = null;
  const store = new PostgresPlaybooksStore(deps.db, deps.events, recorder, {
    runFinished: (info) => metrics?.runFinished(info),
  });
  metrics = new PlaybookMetrics(() => store.approvals.countPending());
  const bullQueue = deps.redis ? new BullMqRunQueue(deps.redis) : null;
  const queue: RunQueue = options.queue ?? bullQueue ?? new NoopRunQueue();

  const catalog = new PlaybookCatalog(store, gateways.audit);
  const runs = new RunService({
    store,
    queue,
    snapshots: gateways.alertSnapshot,
    audit: gateways.audit,
    clock,
    ids,
    logger,
  });
  const approvals = new ApprovalService({ store, queue, audit: gateways.audit, clock, logger });
  const handlers = createStepHandlers({
    gateways,
    actions: options.actions ?? createSimulatedIntegrations(recorder, clock),
    approvals: store.approvals,
    clock,
    ids,
  });
  const executor = new RunExecutor({
    runs: store.runs,
    handlers,
    queue,
    clock,
    observer: metrics,
    logger,
  });
  const api: PlaybooksPublicApi = { runsForAlert: (alertId) => runs.forAlert(alertId) };

  const module: SpineModule = {
    name: 'playbooks',
    routes: (app) =>
      registerPlaybookRoutes(app, { catalog, runs, approvals, simulatedActions: recorder }),
    subscribers: () => playbookSubscribers({ runs, repository: store.runs, queue }),
    backgroundTasks: () => {
      const tasks = [
        new PlaybookSeedTask(catalog, path.resolve(config.CONFIG_DIR, 'playbooks'), logger),
        new RunReconcilerTask(() => executor.reconcile(), logger),
        new ApprovalExpiryTask(
          () => approvals.expireDue(),
          config.PLAYBOOK_APPROVAL_SWEEP_INTERVAL_MS,
          logger,
        ),
      ];
      if (!deps.redis) return tasks;
      const worker = new RunWorkerTask({
        connection: deps.redis,
        concurrency: config.PLAYBOOK_WORKER_CONCURRENCY,
        logger,
        advance: (runId, signal) => executor.advanceRun(runId, signal),
      });
      const closeQueue = {
        name: 'playbook-run-queue',
        start: () => undefined,
        stop: () => bullQueue?.close() ?? Promise.resolve(),
      };
      return [...tasks, worker, closeQueue];
    },
  };
  return { module, api, catalog, runs, approvals, executor, store, queue };
}
