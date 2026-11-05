# ADR-0030: Normalizers are pure functions returning a typed Result; no `generic` normalizer

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** architecture, data

## Context and problem statement

[ADR-0011](0011-canonical-alert-schema.md) says every source is mapped into one canonical
alert "at the edge" by a pure normalizer. It leaves open three practical questions:

1. **How does a normalizer report bad input?** Sensors send malformed lines all the time. A
   batch import of 50 000 lines must report "line 4 712: missing timestamp" and carry on, so a
   bad record is an _expected outcome_, not an exceptional one.
2. **What happens between "normalized" and "stored"?** Indicators must be extracted and
   normalized, the raw payload capped at 64 KiB, and the fingerprint computed. Where does that live?
3. **What is the `generic` normalizer?** The Phase 0 config enum listed
   `canonical | suricata-eve | cef | generic`, but nothing defined what `generic` would do.

## Decision drivers

- Normalizers must be trivially unit-testable (input → output, no setup) and must never crash
  the request on hostile input.
- The type system should force callers to handle failure.
- Adding a source should mean one new pure function plus fixtures (ADR-0011).
- No feature that silently produces wrong data.

## Considered options

For error reporting:

1. **Return `Result<CanonicalAlert, NormalizationError>`** (a discriminated union `{ok:true,value} | {ok:false,error}`)
2. Throw a `NormalizationError` exception
3. Return `CanonicalAlert | null`

For `generic`:

1. **Remove it from `WebhookSourceSchema`**
2. Implement it as a heuristic mapper ("look for `title`/`name`/`rule_name`, `severity`/`level`…")
3. Implement it as a configurable field-mapping DSL (JSONPath per canonical field, per source)

## Decision outcome

**Result type, a fixed preparation pipeline, and no `generic` normalizer.**

```
raw (string | object) ──normalizer──▶ Result<CanonicalAlert, NormalizationError>
                                        │ ok
                                        ▼
                 prepareAlert(): extractIndicators → capRawPayload → computeFingerprint
                                        │
                                        ▼
                                IngestAlert use case (I/O)
```

- Signature: `(raw: unknown, context?: { receivedAt?: string }) => Result<CanonicalAlert, NormalizationError>`.
  `CanonicalAlert` (defaults applied) is assignable to `CanonicalAlertInput`, so this satisfies
  the brief's `Result<CanonicalAlertInput, …>` while giving callers the stronger type.
- Every normalizer ends by passing its candidate through `CanonicalAlertInputSchema`, so
  "produced by a normalizer" always implies "valid canonical alert".
- `NormalizationError.code` is one of `invalid_json | not_an_alert | parse_error | missing_field | schema_violation`.
  `not_an_alert` lets the batch importer count Suricata `flow`/`dns` telemetry as **skipped**
  instead of as errors.
- The optional `context.receivedAt` keeps normalizers pure (no clock inside) while allowing a
  documented fallback for formats where event time is optional (CEF, see ADR-0031).
- The raw payload cap counts **UTF-8 bytes** of `JSON.stringify(raw)`, not JavaScript string
  length: `'é'.length` is 1 but it is 2 bytes, and the limit is named in bytes. Oversized
  payloads are replaced by `{ truncated: true, bytes }`.
- `generic` is removed from the config enum. The registry is `canonical | suricata-eve | cef`.

### Consequences

- 👍 Bad input can't crash ingestion; the compiler makes every caller handle `ok: false`.
- 👍 Normalizer tests are one-liners over fixtures, and coverage of the domain is ~98 %.
- 👍 One place (`prepareAlert`) defines what "ready to store" means.
- 👎 A sender whose format isn't supported must either send canonical JSON or wait for a new
  normalizer. We accept this: writing a normalizer is ~100 lines plus fixtures.
- ⚖️ `WEBHOOK_SOURCES_JSON` entries with `"normalizer": "generic"` now fail config validation at
  startup (fail fast) instead of failing at the first request. None existed.

## Pros and cons of the options

### Throwing exceptions

- 👍 Familiar.
- 👎 Invisible in the type signature; easy to forget the `try` in a batch loop, so one bad line
  kills the whole import. Exceptions are for bugs and infrastructure failures, which we still throw.

### `CanonicalAlert | null`

- 👍 Simplest.
- 👎 Loses _why_ the record was rejected, which the batch report and the 400 response need.

### Heuristic `generic` mapper

- 👍 "Works" with many JSON shapes out of the box.
- 👎 Silently maps the wrong field (`name` of the _user_ becomes the alert title), and wrong
  data in a SOC is worse than a rejected request. Not explainable.

### Field-mapping DSL

- 👍 Flexible and explicit.
- 👎 A new configuration language to design, validate, document and secure, for a need no
  source has today. YAGNI.

## What would make us revisit this

- Three or more requested sources that differ only in field names: a mapping DSL would then
  pay for itself (write a new ADR that supersedes the `generic` part of this one).
- Normalization shows up as a hot spot in profiles (it is currently dominated by Zod validation).

## Further reading

- Scott Wlaschin, _Railway Oriented Programming_ (2014, talk and article)
- Alexis King, _Parse, don't validate_ (2019, blog post)
