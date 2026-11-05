# ADR-0035: Webhook authentication: HMAC over the raw body, verified in an encapsulated route scope

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** security

## Context and problem statement

[ADR-0017](0017-rbac-model.md) says machine senders authenticate with a per-source HMAC
(`X-Spine-Signature`) plus a timestamp. Getting the details wrong turns this into no
authentication at all:

- The HMAC must be computed over the **exact bytes** the sender signed. Fastify's JSON parser
  turns the body into an object, and re-serializing it doesn't reproduce those bytes
  (whitespace, key order, number formatting such as Suricata's 64-bit `flow_id`).
- String comparison of signatures leaks timing information.
- What should an unknown source id return?

## Decision drivers

- Correct verification of exactly what was signed.
- Constant-time comparison; no secret in logs or responses.
- Don't change body parsing for the rest of the API.

## Considered options

1. **An encapsulated Fastify plugin scope for the webhook route that replaces all content-type parsers with one keeping the raw string**
2. A global `preParsing` hook that buffers every body and stores a copy on the request
3. Re-serialize the parsed JSON and sign that

## Decision outcome

**Option 1.** The webhook route is registered inside its own plugin; there,
`removeAllContentTypeParsers()` + `addContentTypeParser('*', { parseAs: 'string' })` make
`request.body` the raw text (Fastify encapsulation keeps other routes untouched). The handler:

1. Looks the source up with `Object.hasOwn` (so `constructor` or `__proto__` can't match a
   prototype property) → unknown → the standard `404 not-found` problem, which names only the id
   the caller sent.
2. `verifyWebhookSignature` (pure, `ingestion/domain`): both headers present; timestamp is unix
   seconds within **±5 minutes** of the injected clock; signature is `sha256=<64 hex>`; the
   expected value is `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`; comparison with
   `crypto.timingSafeEqual` on two 32-byte buffers. Any failure → `401`, and the precise reason
   (`stale_timestamp`, `signature_mismatch`, …) goes to the log only.
3. Sets `request.principal = { kind: 'webhook', sourceId }` (for audit), then normalizes the raw
   text with the source's configured normalizer and runs the normal ingest use case
   (Idempotency-Key scope `webhook:<sourceId>`, hash of the raw body).

The body limit stays the global 1 MiB. Back-pressure runs first, in `onRequest`.

### Consequences

- 👍 The signature covers exactly what the sender sent, and the raw text also lets the Suricata
  normalizer read 64-bit `flow_id`s without precision loss.
- 👍 Replay of a captured request is limited to the 5-minute window, and within it a replay is
  harmless: it deduplicates (or replays the stored response with the same Idempotency-Key).
- 👎 `404` (unknown source) vs `401` (known source, bad signature) tells a prober which source
  ids exist. Source ids are configuration names, not secrets; the secrets are what protect the
  endpoint. Accepted.
- ⚖️ Requires sender clocks within 5 minutes (NTP). Documented in the module guide.

## Pros and cons of the options

### Global raw-body hook

- 👍 Raw body available everywhere.
- 👎 Doubles memory for every request (including 10 MiB batches) to serve one route.

### Re-serialize and sign

- 👍 No parser changes.
- 👎 Simply wrong: senders sign bytes, not objects. Verification would fail for any sender
  whose JSON formatting differs from ours, which is most of them.

## What would make us revisit this

- Senders that can only sign without a timestamp (some SaaS webhooks): add a per-source
  signature scheme setting.
- Secret rotation without downtime: accept a list of secrets per source.

## Further reading

- Stripe docs, _Check the webhook signatures_ (timestamped HMAC scheme)
- OWASP Cheat Sheet, _Cryptographic Storage_ (constant-time comparison)
- Fastify docs, _Content-Type Parser_ and _Encapsulation_
