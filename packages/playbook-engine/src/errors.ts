/** One validation problem, located by a JSON-path-like string such as `steps[3].next`. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Thrown by {@link RunStore.append} when another writer appended to the run first.
 * The caller must reload the events and decide again (optimistic concurrency, ADR-0010).
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedSeq: number,
  ) {
    super(`run ${runId} was modified concurrently (expected last seq ${expectedSeq})`);
    this.name = 'ConcurrencyError';
  }
}

/**
 * A step handler throws this to say "retrying cannot help" (e.g. invalid input).
 * The step then fails immediately, whatever its retry policy says.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** The event log contradicts the definition (corrupt or hand-edited data). */
export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}
