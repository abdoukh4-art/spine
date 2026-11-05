/**
 * Error vocabulary of the resilience stack (ADR-0014). Each failure mode has its own class
 * so that the enrichment service can map it to a precise `EnrichmentResult.status`
 * (`timeout`, `circuit_open`, `rejected` or `error`) and so that retry can decide what is
 * worth retrying.
 */

/** An attempt took longer than its time budget. Transient: worth retrying. */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/** The circuit breaker is open (or half-open with all probe slots taken): the call was not made. */
export class CircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`circuit open; retry after ${retryAfterMs} ms`);
    this.name = 'CircuitOpenError';
  }
}

/** The bulkhead is saturated (all slots busy and the queue is full): the call was not made. */
export class BulkheadRejectedError extends Error {
  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    super(`bulkhead full (${maxConcurrent} in flight, ${maxQueue} queued)`);
    this.name = 'BulkheadRejectedError';
  }
}

/**
 * A provider failure that is expected to go away on its own (HTTP 429/503, connection
 * reset…). Providers throw this to tell retry "try again"; any other error is permanent.
 */
export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientProviderError';
  }
}

/**
 * Default retry classifier: only timeouts and explicit transient provider errors are
 * retried. Retrying a permanent error (bad input, a bug) just multiplies the load.
 */
export function isTransientError(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof TransientProviderError;
}
