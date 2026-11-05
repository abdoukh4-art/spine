# ADR-0018: All response actions go through simulated adapters

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** security, architecture

## Context and problem statement

A SOAR platform's value comes from _acting_: blocking an IP, opening a ticket, notifying a
channel. Spine is a portfolio and learning project that must run offline and must
**never** ship real offensive or destructive capability, or contact real third-party systems.

## Decision drivers

- Safety: no real network side effects, ever.
- Realism: the adapters must behave like real ones (latency, failures, idempotency) so
  that resilience and compensation logic are actually exercised.
- Replaceability: a real adapter could later be added behind the same port without
  touching the playbook engine.

## Considered options

1. **Ports per action category (`FirewallPort`, `TicketingPort`, `ChatPort`) with simulated adapters that persist their effects to a local table and support fault injection**
2. Log-only stubs (`console.log("would block")`)
3. Docker containers emulating real products (e.g. a real iptables container)

## Decision outcome

**Chosen option 1.**

- `SimulatedFirewall.block(indicator, {idempotencyKey, ttl})` records an entry in
  `simulated_actions` and returns a deterministic `externalId`. Calling it twice with the same
  idempotency key returns the same result (as a well-behaved real API would).
  `unblock` exists for compensation.
- `SimulatedTicketing.create(…)` returns `SIM-<n>` ticket IDs. `SimulatedChat.post(…)` stores messages.
- Each adapter has configurable `latencyMs` and `failureRate` (env/config), so the demo
  and the tests can exercise retries and compensation.
- The console shows a "Simulated integrations" page listing everything that _would_ have
  happened. That makes it a useful teaching view.
- Code review rule: any adapter that performs real network I/O must be rejected in this repo.

### Consequences

- 👍 The demo is fully realistic and fully safe, and tests are deterministic.
- 👍 Compensation (`unblock`) is verifiable: the table shows block → unblock.
- 👎 Some extra code to maintain for adapters with no production use.

## Pros and cons of the options

### Log-only stubs

- 👎 Can't test idempotency, failures or compensation, so it teaches nothing about real integrations.

### Emulated real products

- 👎 Heavy, and drifts toward real capability. It conflicts with the safety driver.

## What would make us revisit this

- Never within this repository. Real adapters, if anyone builds them, belong in a separate
  plugin package with its own threat model.
