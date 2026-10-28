# ADR-0011: One canonical alert schema inspired by ECS/OCSF, with MITRE ATT&CK mapping

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** data

## Context and problem statement

Every detection tool emits a different JSON shape. If enrichment, scoring and playbooks
had to understand each one, every new source would mean changes across the whole system.
We need one internal shape that every source is mapped into **at the edge**.

## Decision drivers

- Downstream code handles exactly one shape.
- Industry-recognizable field names, so learners can transfer the knowledge.
- Room for MITRE ATT&CK technique mapping, which detection engineers think in.
- The original payload is kept for forensics.

## Considered options

1. **A Spine canonical schema, a pragmatic subset inspired by ECS and OCSF field naming**
2. Adopt full OCSF 1.x (Detection Finding class)
3. Adopt full Elastic Common Schema (ECS)
4. Store raw payloads and normalize lazily per consumer

## Decision outcome

**Chosen option 1.** `CanonicalAlert` (see `packages/shared-schema/src/alert.ts`):

| Group | Fields | Inspired by |
|---|---|---|
| identity | `source.{vendor,product,sourceAlertId}`, `title`, `description`, `category`, `occurredAt` | OCSF `metadata.product`, `finding_info` |
| severity | `severity` (source-reported: `informational…critical`) | OCSF `severity_id` |
| entities | `host.{hostname,ips,os}`, `user.{name,email}`, `network.{sourceIp,sourcePort,destinationIp,destinationPort,protocol}`, `file.{name,path,sha256,md5}`, `url` | ECS `host.*`, `user.*`, `source.*`, `destination.*`, `file.hash.*`, `url.full` |
| observables | `indicators[]: {type, value}`, extracted from entities + explicitly supplied, normalized (lower-cased, de-duplicated) | OCSF `observables` |
| tactics | `mitre[]: {tacticId, techniqueId, …}` with validated IDs (`TA0001`, `T1059.001`) | MITRE ATT&CK |
| extras | `labels: Record<string,string>`, `raw: unknown` (≤ 64 KiB) | ECS `labels` |

Normalizers (`suricata-eve`, `cef` syslog lines, `canonical` passthrough, generic webhook
mapping) live in the Ingestion module. They are **pure functions**: input in, `CanonicalAlert`
or a typed error out.

We keep our own names (camelCase JSON) instead of dotted ECS names, because the schema is
also a TypeScript API. A mapping table to ECS/OCSF lives in
[architecture/data-model.md](../architecture/data-model.md) for interoperability.

### Consequences

- 👍 Adding a source = writing one pure normalizer plus fixtures. Nothing downstream changes.
- 👍 The MITRE mapping powers both scoring rules and console filtering.
- 👎 This is not a standard. Exporting to an OCSF consumer needs a mapping step (documented, not built in v0.1).
- 👎 Fields outside the subset only survive in `raw` and `labels`.

## Pros and cons of the options

### Full OCSF
- 👍 Vendor-neutral standard with growing adoption.
- 👎 Very large (hundreds of attributes, numeric enums like `severity_id`). It hurts readability for learners and API ergonomics.

### Full ECS
- 👍 Well documented, and used by Elastic.
- 👎 Event/log-oriented rather than alert-oriented, with deeply nested dotted names.

### Lazy normalization
- 👍 No upfront mapping work.
- 👎 Pushes N×M complexity onto every consumer. The exact problem we're solving.

## What would make us revisit this

- An integration partner requires OCSF natively. Then add an OCSF export adapter, or
  migrate the canonical schema with a superseding ADR.

## Further reading

- OCSF schema browser: <https://schema.ocsf.io>
- Elastic Common Schema reference
- MITRE ATT&CK: <https://attack.mitre.org>
