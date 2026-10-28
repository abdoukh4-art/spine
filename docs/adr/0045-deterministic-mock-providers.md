# ADR-0045: Fixture-driven mock providers with seeded fault injection

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** testing, architecture

## Context and problem statement

Spine makes no real third-party calls ([00-vision](../00-vision.md), non-goals). Enrichment
still has to look realistic in the demo, and the resilience stack has to be exercisable:
we want to _see_ retries, timeouts and an opening breaker, both in tests and in a running
system. Random failures make tests flaky and demos unrepeatable.

## Decision drivers

- Offline, with no network at all.
- Realistic data that can't be mistaken for real infrastructure.
- Reproducible faults: the same configuration fails the same calls.
- Fixtures editable by non-developers, and bundled into the API build.

## Considered options

1. **JSON fixtures + a seeded PRNG (mulberry32) drawing one number per call, in call order.**
2. Fixtures + `Math.random()` failures.
3. A local fake HTTP server (e.g. WireMock) per provider.

## Decision outcome

**Chosen option 1.**

- `packages/enrichers/fixtures/{reputation,geo,asset-inventory}.json`, validated with Zod
  when the provider is built. A malformed fixture fails at startup.
- **Only safe values:** documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`), private ranges, reserved domains (`.example`, `.test`),
  documentation AS numbers (64496–64511), and well-known test hashes (EICAR, the empty file).
- **Fault injection:** `{ latencyMs, failureRate, seed }`. Each call draws **before** its
  simulated latency, so concurrency timing can't change which call fails. Failures throw
  `TransientProviderError`, so they are retried, as a real 503 would be. The latency
  honours the attempt's `AbortSignal`, so a timeout really cancels the simulated work.
- The three providers get seeds `seed`, `seed+1`, `seed+2`, so their failures are
  independent of each other.
- Fixtures are imported with `import … with { type: 'json' }`, so esbuild bundles them
  ([ADR-0027](0027-workspace-packages-as-source-and-esbuild-bundling.md)): no runtime file paths.
- Environment: `ENRICHMENT_LATENCY_MS`, `ENRICHMENT_FAILURE_RATE`, `ENRICHMENT_SEED`.

### Consequences

- 👍 `ENRICHMENT_FAILURE_RATE=0.6` reproducibly shows retries, breakers opening and data
  gaps in explanations, which makes a good live demo of [ADR-0014](0014-hand-written-resilience-primitives.md).
- 👍 Tests assert exact outcomes for a given seed.
- 👎 "Same calls fail" holds only for the same call _order_. Across worker restarts, or
  with concurrent alerts, the order differs. Good enough for demos, and tests control the order.
- 👎 The fixtures are small (a few dozen entries), so most real-looking indicators come
  back `not_found`.

## Pros and cons of the options

### `Math.random()` failures

- 👍 Trivial.
- 👎 Flaky tests, demos that can't be reproduced.

### A fake HTTP server

- 👍 Exercises real HTTP clients, sockets and timeouts.
- 👎 An extra container per provider, port management in tests, and slower runs. Spine has
  no real HTTP provider yet, so there's no client to exercise.

## What would make us revisit this

- The first real provider is added → add an HTTP-level fake (e.g. a tiny Fastify app in
  the test) to exercise its client, and keep the fixture mocks for the demo.

## Further reading

- RFC 5737 (IPv4 documentation ranges), RFC 3849 (IPv6), RFC 2606 (reserved TLDs), RFC 5398 (documentation ASNs)
- Tommy Ettinger, _mulberry32_ (public-domain PRNG)
