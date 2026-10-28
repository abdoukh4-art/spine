import type {
  EnrichmentResult,
  EnrichmentStatus,
  Indicator,
  ProviderStatus,
} from '@spine/shared-schema';
import type { LookupOutcome } from './enricher.js';
import { BulkheadRejectedError, CircuitOpenError, TimeoutError } from './resilience/errors.js';
import type { ResilientProvider } from './resilient-enricher.js';
import { lookupTargets, type EnrichmentInput } from './targets.js';
import { realScheduler, toError, type Scheduler } from './time.js';

/** Collaborators and limits for {@link EnrichmentService}. */
export interface EnrichmentServiceOptions {
  /** Maximum lookups in flight for ONE `enrich` call (across providers). Default 8. */
  concurrency?: number;
  /** Clock for `durationMs` and `fetchedAt`. Defaults to the real scheduler. */
  scheduler?: Scheduler;
  /** Called once per finished lookup (wire it to the duration histogram). */
  onResult?: (result: EnrichmentResult) => void;
}

/** Per-call options for {@link EnrichmentService.enrich}. */
export interface EnrichOptions {
  /** Only use these providers (by name). Default: all. */
  providers?: readonly string[] | undefined;
  /** Caller's cancellation signal. */
  signal?: AbortSignal | undefined;
}

const MAX_ERROR_LENGTH = 500;

/**
 * Maps a failure from the resilience stack to a result status (ADR-0014). Anything that
 * is not one of the stack's own errors is a provider `error`.
 */
export function statusForError(
  error: unknown,
): Extract<EnrichmentStatus, 'timeout' | 'circuit_open' | 'rejected' | 'error'> {
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof CircuitOpenError) return 'circuit_open';
  if (error instanceof BulkheadRejectedError) return 'rejected';
  return 'error';
}

/**
 * Orchestrates the lookups for one alert: every (indicator, provider) pair the provider
 * supports, with bounded concurrency, each through that provider's resilience stack.
 *
 * **It never throws because of a provider.** Each failure becomes a result with a failed
 * status, so scoring can go on with partial data and list the gap (ADR-0014, ADR-0015).
 * Results come back in a deterministic order: target order, then provider order.
 */
export class EnrichmentService {
  private readonly concurrency: number;
  private readonly scheduler: Scheduler;

  /** @throws Error when two providers share a name. */
  constructor(
    private readonly providers: readonly ResilientProvider[],
    private readonly options: EnrichmentServiceOptions = {},
  ) {
    const names = new Set(providers.map((p) => p.name));
    if (names.size !== providers.length) throw new Error('provider names must be unique');
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
    this.scheduler = options.scheduler ?? realScheduler;
  }

  /** Names of the configured providers, in order. */
  providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** Live health of every provider. */
  status(): ProviderStatus[] {
    return this.providers.map((p) => p.status());
  }

  /** Enriches an alert's indicators and host. Resolves with one result per lookup made. */
  async enrich(input: EnrichmentInput, options: EnrichOptions = {}): Promise<EnrichmentResult[]> {
    const selected = options.providers
      ? this.providers.filter((p) => options.providers?.includes(p.name))
      : this.providers;
    const tasks: { provider: ResilientProvider; indicator: Indicator }[] = [];
    for (const indicator of lookupTargets(input)) {
      for (const provider of selected) {
        if (safeSupports(provider, indicator)) tasks.push({ provider, indicator });
      }
    }
    return mapWithConcurrency(tasks, this.concurrency, (task) =>
      this.lookupOne(task.provider, task.indicator, options.signal),
    );
  }

  private async lookupOne(
    provider: ResilientProvider,
    indicator: Indicator,
    signal: AbortSignal | undefined,
  ): Promise<EnrichmentResult> {
    const startedAt = this.scheduler.now();
    let result: EnrichmentResult;
    try {
      const outcome = await provider.lookup(indicator, signal);
      result = this.fromOutcome(provider.name, indicator, outcome, startedAt);
    } catch (error) {
      result = {
        ...this.base(provider.name, indicator, startedAt),
        status: statusForError(error),
        error: toError(error).message.slice(0, MAX_ERROR_LENGTH),
      };
    }
    this.options.onResult?.(result);
    return result;
  }

  private fromOutcome(
    provider: string,
    indicator: Indicator,
    outcome: LookupOutcome,
    startedAt: number,
  ): EnrichmentResult {
    const base = this.base(provider, indicator, startedAt);
    if (outcome.kind === 'not_found') return { ...base, status: 'not_found' };
    const verdict =
      outcome.verdict ?? (outcome.data.kind === 'reputation' ? outcome.data.verdict : undefined);
    return {
      ...base,
      status: 'ok',
      data: outcome.data,
      ...(verdict === undefined ? {} : { verdict }),
    };
  }

  private base(
    provider: string,
    indicator: Indicator,
    startedAt: number,
  ): Pick<EnrichmentResult, 'provider' | 'indicator' | 'durationMs' | 'fetchedAt'> {
    const now = this.scheduler.now();
    return {
      provider,
      indicator,
      durationMs: Math.max(0, Math.round(now - startedAt)),
      fetchedAt: new Date(now).toISOString(),
    };
  }
}

function safeSupports(provider: ResilientProvider, indicator: Indicator): boolean {
  try {
    return provider.supports(indicator);
  } catch {
    return false; // a buggy predicate must not break enrichment of the whole alert
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
