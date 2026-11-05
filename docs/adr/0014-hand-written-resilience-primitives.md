# ADR-0014: Hand-written, tested resilience primitives for enrichment (timeout, retry+jitter, circuit breaker, bulkhead)

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture

## Context and problem statement

Enrichment calls external providers (simulated in Spine, but designed as if real). They
will be slow, rate-limited and sometimes down. Without protection, one slow provider holds
connections and event-loop capacity, the enrichment queue backs up, and ingestion latency
rises. That's a classic cascading failure.

## Decision drivers

- A slow or failing provider must never stall the rest of the pipeline (goal G4).
- Each pattern must be **observable**: metrics for breaker state, rejections, retries.
- Learners should be able to read how each pattern works.
- Deterministic tests, using injectable clocks and random sources.

## Considered options

1. **Hand-written primitives in `packages/enrichers/src/resilience/`, composed per provider**
2. `opossum` (circuit breaker) + `p-retry` + `p-limit`
3. `cockatiel` (policy library inspired by Polly)

## Decision outcome

**Chosen option 1**, composed in this order (outermost first):

```
bulkhead(maxConcurrent, maxQueue)        → reject fast when saturated
  └─ circuitBreaker(failureRate, window, cooldown, halfOpenProbes)
       └─ retry(maxAttempts, base, cap, FULL jitter, retryOn: transient only)
            └─ timeout(ms, AbortSignal)   → per attempt
                 └─ provider.lookup(indicator, { signal })
```

- **Why this order?** The bulkhead outermost bounds total concurrency _including retries_.
  The breaker sits outside retry so that one logical call counts once toward the failure
  rate, and an open breaker short-circuits all retries. The timeout is per attempt, so
  retry can recover from a single slow attempt.
- **Full jitter** (`sleep = random(0, min(cap, base·2^attempt))`) per the AWS Architecture
  Blog analysis. It spreads retry storms better than "equal" jitter.
- Breakers are **per provider**, never global. Bulkheads are per provider too, so a slow
  geo-IP provider can't starve reputation lookups.
- All primitives take an injectable `Clock` and `Random`, so tests are deterministic and
  run in fake time.
- A failed provider yields an `EnrichmentResult` with `status: timeout | error | circuit_open | rejected`.
  **Enrichment never fails the alert**: scoring proceeds with partial data and the
  explanation says what was missing.

### Consequences

- 👍 Each primitive is about 50–120 lines, fully unit- and property-tested, and doubles as
  a teaching artefact (see the [enricher tutorial](../tutorials/02-write-an-enricher.md)).
- 👍 There are no transitive dependencies for a security-sensitive path.
- 👎 We own the bugs. Mitigated by property-based tests (e.g. "a bulkhead never exceeds
  maxConcurrent in-flight calls under any interleaving").
- 👎 Missing advanced features (adaptive concurrency, sliding-log breakers).

## Pros and cons of the options

### opossum + p-retry + p-limit

- 👍 Battle-tested.
- 👎 Three libraries with different idioms. opossum's timeout doesn't abort the
  underlying call (it lets it run on), and it's harder to inject a fake clock.

### cockatiel

- 👍 A coherent policy API, and it supports `AbortSignal`.
- 👎 Hides the mechanics we want to teach. A reasonable future swap; the interfaces are close.

## What would make us revisit this

- A bug in a primitive causes a production incident → switch to cockatiel behind the same interface.
- Real providers need adaptive rate limiting (token bucket synced to provider quotas).

## Further reading

- Michael Nygard, _Release It!_ 2nd ed., ch. 5 "Stability Patterns"
- Marc Brooker, _Exponential Backoff And Jitter_ (AWS Architecture Blog, 2015)
- Microsoft, _Circuit Breaker pattern_ (Azure Architecture Center)
