# ADR-0044: Resilience defaults and circuit-breaker semantics for enrichment providers

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** architecture, ops

## Context and problem statement

[ADR-0014](0014-hand-written-resilience-primitives.md) fixed _which_ primitives we use and
in which order. Implementing them forced several smaller choices that change behaviour in
production: the breaker's window type, what counts as a failure, what "half-open" lets
through, where breaker state lives, and the default numbers.

## Decision drivers

- Predictable behaviour that is easy to explain and test.
- A caller cancelling must not look like a provider failing.
- Sensible defaults for mock providers answering in ~30 ms, overridable by environment.

## Considered options

For the breaker window:

1. **Count-based**: the last N calls.
2. Time-based: calls in the last T seconds.

For the half-open state:

1. **Allow `halfOpenMaxCalls` concurrent probes; close after that many successes; any
   failure re-opens.**
2. Allow probes, then compute a failure rate over them (resilience4j style).

## Decision outcome

**Count-based window, and probes that must all succeed.** In detail:

- **Window:** the outcomes of the last `windowSize` calls (default 20). The circuit opens
  when `failures / calls ≥ failureRateThreshold` (default 0.5) **and** `calls ≥
minimumCalls` (default 10). The minimum stops one early failure from opening a cold breaker.
- **What counts as a failure:** every error except the caller's own abort (`AbortedError`
  or a DOM `AbortError`). Timeouts, transient and permanent provider errors all count.
  `not_found` is a success: the provider answered.
- **One logical call = one outcome.** The breaker sits outside retry, so three failed
  attempts count once.
- **Open → half_open** after `cooldownMs` (default 10 s), evaluated **lazily** on the next
  call or state read. No timer is involved, so a breaker never keeps the process alive and
  tests need no timers. Consequence: the `spine_enrichment_circuit_state` gauge moves to
  `half_open` only when traffic (or `GET /enrichment/providers`) touches the breaker.
- **Half-open:** up to `halfOpenMaxCalls` (default 1) concurrent probes; extra calls fail
  fast with `CircuitOpenError`. After that many successes, close (with an empty window).
  Any probe failure re-opens and restarts the cooldown.
- **Generations:** each transition bumps a counter. A call that started in an earlier
  state and finishes later is ignored, so a slow straggler from the closed period can't
  close or re-open a half-open breaker.
- **State is per process.** The API process and each worker have their own breakers.
  `GET /enrichment/providers` served by the API shows the API's breakers, which only see
  re-enrichment traffic. The worker's breakers are visible through the metrics gauge,
  which every process exports.

**Defaults** (`DEFAULT_RESILIENCE`, overridable via `ENRICHMENT_TIMEOUT_MS` and
`ENRICHMENT_MAX_ATTEMPTS`):

| Setting                     | Default      | Why                                                                                  |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| timeout (per attempt)       | 1000 ms      | ~30× the mock latency. Real reputation APIs answer in 100–500 ms at p99.             |
| retry attempts              | 3            | Recovers from isolated blips. More just lengthens the worst case.                    |
| backoff base / cap          | 50 / 1000 ms | Full jitter. The worst case for one lookup is ~3 s + 2 × 1 s of backoff.             |
| breaker window / minimum    | 20 / 10      | Large enough not to flap on two errors, small enough to react within one busy alert. |
| failure-rate threshold      | 50 %         | A provider failing half the time is mostly adding latency.                           |
| cooldown                    | 10 s         | Short enough that recovery shows up quickly in the demo.                             |
| bulkhead concurrent / queue | 16 / 64      | 8 event-worker slots × up to 8 lookups per alert, spread over 3 providers.           |

### Consequences

- 👍 Deterministic, timer-free breaker logic, fully covered by property tests
  ("never lets a call through while open before the cooldown").
- 👍 Cancelling a lookup (shutdown, request aborted) never opens a breaker.
- 👎 A count-based window reacts slowly when traffic is low: 10 calls are needed before
  it can open at all. At low volume the per-attempt timeout is what protects us.
- 👎 Per-process state means N workers need N × `minimumCalls` failures before every
  breaker is open. That's acceptable for a handful of workers.

## Pros and cons of the options

### Time-based window

- 👍 Behaves the same at any traffic level.
- 👎 Needs bucketed counters and a clock for every outcome. More code to teach, and
  harder to property-test.

### Rate-based half-open (resilience4j style)

- 👍 Tolerates one unlucky probe.
- 👎 With the default of one probe it's the same thing anyway. Requiring all probes to
  succeed is simpler and more conservative.

## What would make us revisit this

- Several worker replicas make per-process breakers noticeably slow to open → share
  breaker state in Redis, or add a cluster-wide "provider down" flag.
- Real providers publish rate limits → add a token-bucket limiter in front of the bulkhead.

## Further reading

- Michael Nygard, _Release It!_ 2nd ed., "Circuit Breaker"
- resilience4j documentation, _CircuitBreaker_ (count-based vs time-based sliding windows)
