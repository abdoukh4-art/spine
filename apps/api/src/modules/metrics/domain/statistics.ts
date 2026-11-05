import type { DurationStat } from '@spine/shared-schema';

/**
 * Pure statistics used by every SOC metric (ADR-0026). No I/O, no clocks: callers pass
 * plain numbers, so every formula can be tested against hand-computed fixtures.
 */

/**
 * Nearest-rank percentile of an ascending-sorted array.
 *
 * Definition (documented so tests can be exact): rank = ⌈p/100 × n⌉, result = sorted[rank − 1].
 * For p = 50 and n = 4 that is the 2nd value (not the average of the 2nd and 3rd), which
 * means the result is always a value that was actually observed.
 *
 * @param sortedAscending values sorted ascending; must be non-empty
 * @param p percentile in (0, 100]
 */
export function percentileNearestRank(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) throw new RangeError('percentile of an empty set');
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[rank - 1] as number;
}

/** Rounds to millisecond precision so floating-point noise doesn't leak into API responses. */
function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Summarizes durations (in seconds) as count, mean, p50 and p90. All statistics are
 * `null` when there are no samples. A mean of zero samples is undefined, not zero.
 */
export function durationStat(seconds: readonly number[]): DurationStat {
  if (seconds.length === 0) {
    return { count: 0, meanSeconds: null, p50Seconds: null, p90Seconds: null };
  }
  const sorted = [...seconds].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    count: sorted.length,
    meanSeconds: roundSeconds(mean),
    p50Seconds: roundSeconds(percentileNearestRank(sorted, 50)),
    p90Seconds: roundSeconds(percentileNearestRank(sorted, 90)),
  };
}

/** Milliseconds between two dates, in seconds. */
export function secondsBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 1000;
}
