# ADR-0012: Idempotency keys for requests; fingerprint-based deduplication for alerts

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** data, architecture

## Context and problem statement

There are two different kinds of "the same alert again":

1. **Transport retries.** A sender times out and resends _the same HTTP request_. We must
   return the original result and never create a second alert.
2. **Semantic duplicates.** A detector fires the _same detection_ repeatedly (every 5
   minutes for a beaconing host). Each is a valid new request, but analysts want one alert
   with a counter, not 288 alerts a day.

These need different mechanisms.

## Decision drivers

- Safe client retries (the HTTP `Idempotency-Key` convention, IETF draft).
- Noise reduction without hiding genuinely new activity.
- Deterministic and explainable dedup decisions.

## Considered options

1. **Idempotency-Key table for (1) + deterministic fingerprint with an open-alert window for (2)**
2. Fingerprint only, with no idempotency keys
3. Idempotency keys only
4. Probabilistic / ML clustering of similar alerts

## Decision outcome

**Chosen option 1.**

**Idempotency (transport level).**

- `POST /api/v1/alerts` and webhook endpoints accept an `Idempotency-Key` header (1–255 chars).
- The `idempotency_keys` table stores `(scope, key) → request_hash, response_status, response_body, created_at`.
  `scope` is the authenticated principal or webhook source, so keys can't collide across tenants of the API.
- Same key + same request hash → replay the stored response (with header `Idempotent-Replay: true`).
- Same key + **different** body → `409 Conflict` (`problem type: idempotency-key-reused`).
- Records expire after 24 h (cleanup job).

**Deduplication (semantic level).**

- `fingerprint = sha256(vendor | product | sourceAlertId)` when the source provides a stable ID;
  otherwise `sha256(vendor | product | category | normalizedTitle | sorted(indicators))`.
- If an alert with that fingerprint exists **and is not closed** (`resolved`/`false_positive`),
  the new occurrence increments `duplicate_count`, updates `last_seen_at`, and emits
  `alert.deduplicated`. It is **not** re-enriched or re-scored.
- If the matching alert _is_ closed, a **new** alert is created, because re-occurrence after
  closure is meaningful (the fix didn't work).
- A partial unique index `UNIQUE (fingerprint) WHERE status NOT IN ('resolved','false_positive')`
  makes the rule race-safe: two concurrent inserts can't both create an open alert.

### Consequences

- 👍 Retrying clients are safe. Floods of repeated detections collapse into one alert.
- 👍 The rule is explainable ("deduplicated into alert X because fingerprint F matched an open alert").
- 👎 Fingerprints that are too coarse could merge distinct incidents. Mitigated by
  preferring `sourceAlertId` and including indicators in the fallback.
- 👎 The idempotency table grows with traffic. Mitigated by the 24 h TTL cleanup.

## Pros and cons of the options

### Fingerprint only

- 👎 A retried request after the alert was closed would create a spurious new alert.

### Idempotency keys only

- 👎 Does nothing about repeated detections, which are the main source of noise.

### ML clustering

- 👍 Catches near-duplicates.
- 👎 Non-deterministic and hard to explain. Out of scope (non-goal).

## What would make us revisit this

- Analysts report merged-but-distinct incidents more than 1 % of the time → make fingerprint
  fields configurable per source.
- We need a time-bounded dedup window (e.g. 24 h even for open alerts).

## Further reading

- IETF draft, _The Idempotency-Key HTTP Header Field_
- Stripe engineering, _Designing robust and predictable APIs with idempotency_
