import { createHash } from 'node:crypto';
import { SIMULATED_ACTION_KINDS, type Page, type SimulatedAction } from '@spine/shared-schema';
import { sql, type Selectable } from 'kysely';
import type { SimulatedActionsTable } from '../../../../platform/db/schema.js';
import { paginate } from '../../../../platform/http/pagination.js';
import type { Clock, IdGenerator } from '../../../../platform/runtime.js';
import type { ActionOptions, SimulatedActionReader } from '../../application/ports.js';
import { timestampCursor, type Executor } from '../postgres/shared.js';

type Row = Selectable<SimulatedActionsTable>;
type Kind = SimulatedAction['kind'];

/** Thrown by fault injection: a simulated outage of the integration (ADR-0018). */
export class SimulatedOutageError extends Error {
  constructor(kind: Kind) {
    super(`simulated outage of ${kind} (fault injection)`);
    this.name = 'SimulatedOutageError';
  }
}

/** Fault-injection knobs (SIMULATION_LATENCY_MS / SIMULATION_FAILURE_RATE). */
export interface SimulationOptions {
  latencyMs: number;
  failureRate: number;
  /** Source of randomness for failures; injectable for deterministic tests. */
  random?: () => number;
  /** Per-kind override of the failure rate (tests use it to break one integration). */
  failureRateByKind?: Partial<Record<Kind, number>>;
}

/**
 * Records the effect of a simulated response action exactly once per idempotency key,
 * the way a well-behaved real API does (ADR-0018):
 *
 * 1. If an action with this key exists, return its stored response (a replay).
 * 2. Otherwise wait `latencyMs` and maybe fail (fault injection) before doing anything.
 * 3. Insert the row with `ON CONFLICT (idempotency_key) DO NOTHING` and return whichever
 *    row won, so two racing workers still produce exactly one effect.
 */
export class SimulatedActionRecorder implements SimulatedActionReader {
  private readonly random: () => number;

  constructor(
    private readonly db: Executor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly options: SimulationOptions,
  ) {
    // Fault injection is test/demo randomness, not security-relevant.
    this.random = options.random ?? Math.random;
  }

  /** Performs (or replays) an action and returns its response. */
  async perform(
    kind: Kind,
    options: ActionOptions,
    request: Record<string, unknown>,
    respond: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.findByKey(options.idempotencyKey);
    if (existing) return existing.response;
    if (!options.dryRun) await this.injectFaults(kind, options.signal);
    const response = await respond();
    await this.db
      .insertInto('simulated_actions')
      .values({
        id: this.ids.next(),
        kind,
        idempotency_key: options.idempotencyKey,
        run_id: options.runId,
        step_id: options.stepId,
        request: JSON.stringify(request),
        response: JSON.stringify(response),
        dry_run: options.dryRun,
        created_at: this.clock.now().toISOString(),
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute();
    const stored = await this.findByKey(options.idempotencyKey);
    return stored?.response ?? response;
  }

  /** Next human-friendly ticket number (SIM-1000, SIM-1001, …). */
  async nextTicketNumber(): Promise<number> {
    const result = await sql<{
      n: string;
    }>`select nextval('simulated_ticket_seq')::text as n`.execute(this.db);
    return Number(result.rows[0]?.n ?? 0);
  }

  async list(filter: {
    kind?: Kind;
    limit: number;
    cursor?: string;
  }): Promise<Page<SimulatedAction>> {
    let query = this.db.selectFrom('simulated_actions').selectAll();
    if (filter.kind) query = query.where('kind', '=', filter.kind);
    const cursor = timestampCursor(filter.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', cursor.k),
          eb.and([eb('created_at', '=', cursor.k), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(filter.limit + 1)
      .execute();
    const page = paginate(rows, filter.limit, (r) => ({ k: r.created_at.toISOString(), id: r.id }));
    return { items: page.items.map(toAction), nextCursor: page.nextCursor };
  }

  private findByKey(key: string): Promise<Row | undefined> {
    return this.db
      .selectFrom('simulated_actions')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async injectFaults(kind: Kind, signal: AbortSignal): Promise<void> {
    if (this.options.latencyMs > 0) await sleep(this.options.latencyMs, signal);
    const rate = this.options.failureRateByKind?.[kind] ?? this.options.failureRate;
    if (rate > 0 && this.random() < rate) throw new SimulatedOutageError(kind);
  }
}

/** A short, stable ID derived from an idempotency key (same key → same ID). */
export function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toAction(row: Row): SimulatedAction {
  return {
    id: row.id,
    kind: SIMULATED_ACTION_KINDS.find((k) => k === row.kind) ?? 'chat.post',
    runId: row.run_id,
    stepId: row.step_id,
    dryRun: row.dry_run,
    request: row.request,
    response: row.response,
    createdAt: row.created_at.toISOString(),
  };
}
