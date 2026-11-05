# ADR-0032: Indicator extraction and normalization rules

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** data

## Context and problem statement

Indicators (IPs, domains, URLs, hashes, emails, host and user names) drive three things:
one enrichment lookup per indicator × provider, scoring rules, and the fallback deduplication
fingerprint ([ADR-0012](0012-idempotency-and-deduplication.md)). The same observable arrives in
many spellings: `EVIL.example.`, `evil[.]example`, `hxxps://evil[.]example`, `2001:DB8:0:0::1`.
If they stay different strings, we enrich the same thing several times and two copies of one
alert get different fingerprints.

## Decision drivers

- One observable → one canonical string, so dedup and enrichment caches work.
- A bad value must not reject the whole alert (a sensor that sent one malformed IP still saw something).
- The function must be provably safe to apply twice (it runs on canonical input from clients
  that may have normalized already).
- Pure, no `node:net`, so it stays in the domain layer ([ADR-0002](0002-hexagonal-modular-monolith.md)).

## Considered options

1. **Normalize per type, drop invalid values, de-duplicate, sort, cap at 256**
2. Validate strictly and reject the alert on any invalid indicator
3. Store indicators exactly as received

## Decision outcome

**Option 1**, implemented in `ingestion/domain/indicators.ts` and `ip.ts`:

| Type                           | Normalization                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all (except hashes, usernames) | **refang** until nothing changes: `hxxp`→`http`, `[.]` `(.)` `{.}` `[dot]`→`.`, `[@]` `(@)` `[at]`→`@`, `[://]`, `[:]`                                        |
| `ipv4` / `ipv6`                | trimmed; IPv4 without leading zeros; IPv6 in RFC 5952 form (lower-case, zero-compressed); the type is **corrected** to the real family                        |
| `domain`                       | lower-case, trailing dot removed, IDN → punycode, labels `[a-z0-9_-]{1,63}`, ≥ 2 labels, numeric TLD rejected; an IP sent as a domain becomes an IP indicator |
| `hostname`                     | like `domain` but a single label (`fin-ws-042`) is allowed                                                                                                    |
| `url`                          | parsed by the WHATWG `URL` class and re-serialized (`href`); only `http`, `https`, `ftp`                                                                      |
| `email`                        | lower-cased entirely; the domain part validated like `domain`                                                                                                 |
| `md5`/`sha1`/`sha256`          | lower-case hex of exactly 32/40/64 characters                                                                                                                 |
| `username`                     | trimmed only (case is meaningful on many systems), no control characters, ≤ 255 chars                                                                         |

Then: drop invalid values, de-duplicate on `(type, value)`, **sort** (by type order, then value),
keep the first 256. Extraction adds indicators from `host`, `user`, `network`, `file` and `url`
fields, and the host of every URL as a `domain` (or IP).

Refanging loops to a fixpoint because one replacement can reveal another: `[(.)]` becomes `[.]`
after one pass and `.` after two. With a single pass, normalization was not idempotent. The
property test caught it once the generator produced nested defang tokens inside URL paths
(see the [journal](../journal/2026-10-28-ingestion-alerts.md)).

### Consequences

- 👍 Property-tested: idempotent, duplicate-free, order-independent, never throws (fast-check).
- 👍 Sorting makes the stored list deterministic, so the fingerprint and the `alert.ingested`
  payload are byte-identical for the same input.
- 👎 Silently dropped values could hide a sensor bug. Mitigation: the original payload is kept
  in `raw`, and the explicit `indicators` the client sent are visible there.
- 👎 Usernames keep their case, so `Dana` and `dana` are two indicators. Correct for Unix,
  noisy for Windows; revisit per source if it matters.
- ⚖️ Private (RFC 1918) addresses are kept: they identify internal hosts for asset enrichment.

## Pros and cons of the options

### Reject the alert on any invalid indicator

- 👍 Surfaces sender bugs loudly.
- 👎 Throws away real detections because of one cosmetic field.

### Store as received

- 👍 Zero risk of a normalization bug.
- 👎 Defeats deduplication and multiplies enrichment calls.

## What would make us revisit this

- A need to keep the original spelling for display (store `{value, original}`).
- Indicator types beyond the ten in the schema (e.g. `cidr`, `ja3`).

## Further reading

- RFC 5952, _A Recommendation for IPv6 Address Text Representation_
- WHATWG URL Standard (serialization rules)
- David Bianco, _The Pyramid of Pain_ (2013)
