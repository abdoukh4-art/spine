# Metrics: exercise solutions

## 1. Off-by-one hunt

With `Math.round`, rank = round(p/100 × n). For p = 50 and n = 1 that's `round(0.5) = 1` (fine),
but for p = 10 and n = 4 it's `round(0.4) = 0`, and `sorted[-1]` is `undefined`. The property
"percentiles are always observed values" fails, and fast-check shrinks to something like
`xs = [0], p = 1` (rank = round(0.01) = 0). Lesson: the nearest-rank definition needs
**ceil** so that rank ≥ 1 for any p > 0.

## 2. Median vs mean

Nine alerts resolved in 10 minutes and one forgotten for 5 days: mean ≈ (9×600 + 432000)/10 ≈ 43 740 s
(≈ 12 h), median = 600 s (10 min). The mean says "we're slow"; the median says "we're usually
fast but something fell through the cracks". Both are true. The p90 (here 600 s) and the open
count tell you whether the tail is one outlier or a pattern.

## 3. Add p99

Add `p99Seconds: z.number().nullable().optional()` to `DurationStatSchema` (optional = additive),
compute it in `durationStat` with `percentileNearestRank(sorted, 99)`, and extend the fixture tests.
Since [ADR-0095](../../adr/0095-aggregate-metrics-in-the-database.md) production computes the
aggregates in SQL, so also add `percentile_disc(0.99)` to both reporting queries and compare `p99Seconds`
in `metrics-sql.test.ts`. Without that step, the TypeScript spec has p99 and production returns `undefined`.
With n = 10, rank = ⌈9.9⌉ = 10, so p99 is just the maximum. Percentiles are only meaningful
when n ≫ 1/(1 − p), so roughly 100+ samples for p99.

## 4. Business hours

The calendar is **domain** knowledge (a rule about how the SOC measures itself), so a pure
`BusinessCalendar` type (staffed intervals per weekday + holidays) and a pure
`staffedSecondsBetween(start, end, calendar)` function belong in `domain/`. Loading the calendar
from config is an adapter concern. Options: (a) compute in the domain with a calendar value
object; (b) pre-compute "staffed seconds" at write time in the Alerts module; (c) do it in SQL.
(a) keeps it testable and local; (b) couples Alerts to a reporting concern; (c) breaks module boundaries.

## 5. Break the SQL, not the spec

What actually happens (run on 2026-10-29), in two stages:

1. **The first counterexample is the empty dataset `[]`**, and the failure is not an assertion but a
   Postgres error: `function round(double precision, integer) does not exist`. `percentile_disc`
   returns the input's type (`numeric` here), while `percentile_cont` returns `double precision`,
   and Postgres only has `round(numeric, int)`. Postgres is strictly typed, and the property test
   found that on its first input.
2. **Add `::numeric` and run again.** fast-check now shrinks to **two alerts** received at the same
   instant, detected after **0 s and 0.001 s**: `expected 0.001 to be +0`. The spec's p50 (nearest rank,
   ADR-0026) is the 1st observed value, 0. `percentile_cont(0.5)` **interpolates** the midpoint, 0.0005,
   which rounds to 0.001. With one alert, or with equal values, the two agree, which is why a
   hand-written fixture can easily miss the bug.

No unit test of `soc-metrics.ts` can catch it, because that file is still correct: the bug lives in a
**second implementation** of the same formula. That's the general lesson of differential testing.
When you implement one definition twice (here TypeScript for clarity and SQL for scale), only a
test that runs **both** on the **same** inputs can tell you they agree.
