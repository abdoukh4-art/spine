# ADR-0026: Precise definitions of MTTD, MTTR and playbook success rate

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** data

## Context and problem statement

"MTTD" and "MTTR" are used loosely in the industry. Different vendors measure from
different start points (event time vs alert time vs ticket time), so their numbers can't be
compared. A metric with no precise definition can't be tested, and it gets gamed.

## Decision drivers

- Unambiguous, testable formulas over fixed fixtures.
- Based on timestamps Spine actually has.
- Robust to outliers (one forgotten alert shouldn't dominate).

## Considered options

1. **Define from Spine timestamps; report mean AND median (p50) and p90; exclude open alerts from MTTR**
2. Mean only
3. Include open alerts in MTTR using "now" as the end time

## Decision outcome

**Chosen option 1.** For a time window `[from, to)` over alerts whose `receivedAt` falls in the window:

| Metric | Definition | Timestamps |
|---|---|---|
| **TTD** (per alert) | `receivedAt − occurredAt` = how long the malicious activity existed before Spine knew about it (detection + delivery latency) | `occurredAt` from the source event, `receivedAt` set by Spine at ingestion |
| **MTTD** | mean of TTD over alerts in window (negative values from clock skew are clamped to 0 and counted in `clockSkewCount`) | |
| **TTR** (per alert) | `resolvedAt − receivedAt`, where `resolvedAt` is the first transition to `resolved` **or** `false_positive` | `resolvedAt` set by the Alerts module |
| **MTTR** | mean of TTR over alerts in the window **that are closed**; `openCount` reported alongside | |
| **Playbook success rate** | `succeeded / (succeeded + failed + compensated)` over runs **finished** in the window; `dry-run` runs excluded; `cancelled` excluded | |
| **Playbook latency** | p50/p95 of `finishedAt − startedAt` for finished, non-dry-run runs, **excluding time spent waiting for approval** (reported separately) | |

Every metric response includes `count`, `mean`, `p50`, `p90` and the window. Percentiles use
the **nearest-rank** method (documented, so tests are exact).

Deduplicated occurrences do not create new alerts, so they don't count toward MTTD. This
is deliberate: MTTD measures detection of *distinct* alerts.

### Consequences

- 👍 Fixture-based tests can assert exact numbers.
- 👍 Median and p90 show skew that the mean hides.
- 👎 Excluding open alerts from MTTR flatters it while backlogs are large. That's why
  `openCount` is always shown next to MTTR in the console.

## What would make us revisit this

- Cases become the unit of response → add case-level MTTR (case created → closed).
- Need for MTTA (time to acknowledge) → add an `acknowledgedAt` timestamp on first triage.

## Further reading

- Google SRE Workbook, *Implementing SLOs* (on percentiles vs means)
- SANS, *SOC Survey* (variation in how SOCs measure MTTD/MTTR)
