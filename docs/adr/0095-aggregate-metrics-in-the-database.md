# ADR-0095: Aggregate SOC metrics in the database, with the TypeScript formulas as the executable spec

- **Status:** accepted (refines [ADR-0026](0026-mttd-mttr-definitions.md), [ADR-0029](0029-metrics-read-side-module-and-cached-gauges.md))
- **Date:** 2026-10-29
- **Deciders:** maintainers
- **Tags:** architecture, performance

## Context and problem statement

The Metrics module computed MTTD, MTTR, alert volume and playbook statistics in Node from **rows**:
the Alerts and Playbooks modules returned every alert received (and every run finished) in the
window, and pure TypeScript functions aggregated them. The pure functions are excellent: they're
the precise, unit-tested definition of ADR-0026. The data flow was not.

The 30-minute soak test (2026-10-29) showed the worker's heap jumping from ~50 MB to ~150 MB
on each 30-second gauge refresh, once the load tests had produced 177 000 alerts in 24 h. It wasn't
a leak (the heap returned to baseline), but memory grew **linearly with alert volume**: at the
pipeline's measured ~45 alerts/s (3.9 M alerts/day), a refresh would exceed the 512 MB container
limit. `GET /metrics/summary` had the same flaw in the API, over a window of up to 90 days.

## Decision drivers

- Constant memory, whatever the alert volume or window length.
- Keep ADR-0026's definitions exact (nearest-rank percentiles, clamping, clock-skew and open counts).
- Keep module ownership (ADR-0029): Metrics never reads another module's tables.
- Keep the definitions readable and unit-testable without a database.

## Considered options

1. **SQL aggregates in the owners' reporting queries, with the TypeScript functions kept as the
   executable specification and a differential property test proving equality.**
2. Stream rows and aggregate incrementally in Node (exact mean; approximate percentiles with t-digest).
3. Materialized views or a rollup table maintained by events (pre-aggregated per minute/hour).
4. Keep rows, but cap the window and sample.

## Decision outcome

**Option 1.**

- `alerts.statsReceivedBetween` and `playbooks.runStatsBetween` return aggregates computed in
  Postgres: `count`, `avg`, `percentile_disc(0.5/0.9)` (Postgres' `percentile_disc` **is** the
  nearest-rank definition: the first value whose cumulative position reaches the fraction),
  `greatest(0, …)` clamping, `count(*) filter (…)` for clock skew, open and in-flight counts,
  and sparse counts per severity and per UTC day.
- The Metrics port returns those aggregates. The domain splits each formula into an "aggregate" step
  (`aggregateAlerts`, `aggregateRuns`: the specification, from rows) and a "present" step
  (`alertVolumeFrom`, `playbookStatsFrom`, `summaryFromAggregates`: zero-filling and success rate).
  Production uses SQL for the first step and the same code for the second.
- **Differential test** (`metrics-sql.test.ts`): fast-check generates random alerts (clock skew,
  reopened alerts carrying a stale `resolved_at`, unscored alerts, rows just outside the window) and
  random runs (dry runs, every status, approval waits). It inserts them, and asserts that the SQL
  aggregates equal `aggregateAlerts`/`aggregateRuns`, 60 datasets per property. Mutation-checked:
  removing the clamp from the SQL fails it with a 1 ms clock-skew counterexample.

Means may differ by **one rounding step (1 ms)**. Postgres averages exact numerics and rounds a tie
(x.xxx5) away from zero, while the TypeScript double is often a hair below the tie. The test found
this on its first run (3871.4045 s) and accepts it. Counts and percentiles, which are observed
values, must be identical.

Option 2 still moves every row over the network and needs an approximate percentile. Option 3 is the
right answer at much larger scale, but needs event-driven maintenance and back-filling. Option 4
changes the definitions.

### Consequences

- 👍 Memory per refresh/request is constant. Each query is one indexed range scan on
  `alerts(received_at)` (or a scan of the runs table for the window).
- 👍 The definitions stay in readable TypeScript, and the SQL is proven equal to them.
- 👎 Each formula exists twice (TS spec + SQL). The differential test is the price of that, and it
  has to run on every change to either.
- 👎 Percentiles need a sort inside Postgres: O(n log n) CPU per query over the window.
- ⚖️ The SQL formulas live in the owning modules' reporting queries, which now encode ADR-0026
  semantics. They're documented there and pinned by the differential test.

## What would make us revisit this

- Windows with tens of millions of alerts → rollup tables (option 3), with percentiles from histograms.
- Metric definitions changing often → generate the SQL from one definition, or keep only one implementation.

## Further reading

- PostgreSQL docs, _Ordered-Set Aggregate Functions_ (`percentile_disc`)
- Hyndman & Fan (1996), _Sample Quantiles in Statistical Packages_ (definition 1 = nearest rank)
