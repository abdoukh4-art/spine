import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../../../platform/logger.js';
import type { BackgroundTask } from '../../../platform/module.js';
import type { PlaybookCatalog, PlaybookSource } from '../application/catalog.js';

/** Reads `*.yaml` / `*.yml` / `*.json` playbook files from a directory (sorted by name). */
export async function readPlaybookSources(dir: string): Promise<PlaybookSource[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => /\.(ya?ml|json)$/i.test(f)).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      source: await readFile(path.join(dir, name), 'utf8'),
      format: name.toLowerCase().endsWith('.json') ? ('json' as const) : ('yaml' as const),
    })),
  );
}

/** Seeds the playbooks shipped in `config/playbooks` when their version isn't stored yet. */
export class PlaybookSeedTask implements BackgroundTask {
  readonly name = 'playbook-seeder';

  constructor(
    private readonly catalog: PlaybookCatalog,
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const result = await this.catalog.seed(await readPlaybookSources(this.dir));
    for (const problem of result.invalid)
      this.logger.error({ problem }, 'invalid playbook file skipped');
    this.logger.info({ inserted: result.inserted, dir: this.dir }, 'playbooks seeded');
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Startup reconciler (ADR-0008, ADR-0051): re-enqueues every run that should be progressing,
 * because Redis may have lost its jobs (it holds only re-creatable state).
 */
export class RunReconcilerTask implements BackgroundTask {
  readonly name = 'playbook-run-reconciler';

  constructor(
    private readonly reconcile: () => Promise<number>,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const count = await this.reconcile();
    this.logger.info({ count }, 'playbook runs re-enqueued at startup');
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** Periodically applies `onTimeout` to approvals past their deadline. */
export class ApprovalExpiryTask implements BackgroundTask {
  readonly name = 'approval-expiry-sweeper';
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly sweep: () => Promise<number>,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const tick = (): void => {
      this.running = this.sweep()
        .then((n) => {
          if (n > 0) this.logger.info({ expired: n }, 'approvals expired');
        })
        .catch((err: unknown) => this.logger.error({ err }, 'approval sweep failed'));
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}
