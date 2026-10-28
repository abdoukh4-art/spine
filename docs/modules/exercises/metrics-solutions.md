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
With n = 10, rank = ⌈9.9⌉ = 10, so p99 is just the maximum. Percentiles are only meaningful
when n ≫ 1/(1 − p), so roughly 100+ samples for p99.

## 4. Business hours

The calendar is **domain** knowledge (a rule about how the SOC measures itself), so a pure
`BusinessCalendar` type (staffed intervals per weekday + holidays) and a pure
`staffedSecondsBetween(start, end, calendar)` function belong in `domain/`. Loading the calendar
from config is an adapter concern. Options: (a) compute in the domain with a calendar value
object; (b) pre-compute "staffed seconds" at write time in the Alerts module; (c) do it in SQL.
(a) keeps it testable and local; (b) couples Alerts to a reporting concern; (c) breaks module boundaries.
