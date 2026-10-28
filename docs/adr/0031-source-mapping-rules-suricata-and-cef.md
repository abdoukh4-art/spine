# ADR-0031: Mapping rules for Suricata EVE and CEF sources

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** data

## Context and problem statement

The two sensor formats Spine supports out of the box don't map one-to-one onto the canonical
schema ([ADR-0011](0011-canonical-alert-schema.md)). Several choices change what analysts see
and, through the fingerprint ([ADR-0012](0012-idempotency-and-deduplication.md)), what gets
deduplicated:

- Which field is the source's stable alert id?
- How do 1–3 (Suricata) and 0–10 (CEF) severities map onto `informational…critical`?
- How do free-text classifications become one of 11 categories?
- What if a CEF line has no event time?

## Decision drivers

- Deduplicate true repeats, never merge distinct detections.
- Follow each format's own documented conventions where they exist.
- Explainable: a learner can read one table and know why an alert got its category.
- Never lose precision silently.

## Considered options

- Suricata `sourceAlertId`: **(a) `flow_id:signature_id`**, (b) `flow_id` (the Phase 1 brief's wording), (c) none (always use the fallback fingerprint).
- CEF severity: **(a) ArcSight bands 0–3 / 4–6 / 7–8 / 9–10**, (b) linear (`n/2.5`).
- Category: **(a) an ordered keyword table, first match wins**, (b) a per-vendor lookup of rule ids, (c) always `other`.
- CEF event time: **(a) `rt` → `start` → `end` → `receivedAt`**, (b) reject lines without one.

## Decision outcome

| Topic              | Rule                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suricata identity  | `source = OISF / Suricata`; `sourceAlertId = "<flow_id>:<signature_id>"`                                                                                                                            |
| Suricata `flow_id` | Read **digit-for-digit from the raw text** when available: it is a 64-bit integer and `JSON.parse` rounds it above 2^53                                                                             |
| Suricata severity  | 1 → high, 2 → medium, 3 → low, 4 → informational, anything else → medium                                                                                                                            |
| Suricata entities  | `src_ip/src_port/dest_ip/dest_port/proto` → `network` (IPs canonicalized, invalid ones dropped); `http.hostname`, `tls.sni`, `dns` names, `fileinfo` hashes → indicators                            |
| Suricata MITRE     | ET-style `alert.metadata.mitre_{tactic,technique}_{id,name}` lists, zipped by index; invalid ids dropped                                                                                            |
| CEF identity       | `source = Device Vendor / Device Product`; `sourceAlertId = externalId` when present                                                                                                                |
| CEF severity       | 0–3 low, 4–6 medium, 7–8 high, 9–10 critical; words `Low/Medium/High/Very-High`; else medium                                                                                                        |
| CEF entities       | `src/spt/dst/dpt/proto` → network; `duser ?? suser` → user (the other becomes a `username` indicator); `dhost ?? shost` → host; `fname/filePath/fileHash` → file; `request` → url (http/https only) |
| CEF extras         | `cs1..6`/`cn1..6` → labels keyed by their `…Label`; labels named like `mitreTechniqueId` / `mitreTacticId` → MITRE; `act`, `outcome`, `cat`, `dvchost`… → `cef.*` labels                            |
| CEF event time     | `rt` → `start` → `end` (epoch s/ms, ISO, or `MMM dd yyyy HH:mm:ss`, read as UTC) → `receivedAt` fallback                                                                                            |
| Category (both)    | Ordered keyword rules in `normalizers/fields.ts` over the rule name and the source's category text; first match wins, default `other`                                                               |

Why `flow_id:signature_id` and not `flow_id` alone: one flow can trigger several different
signatures (an `ET POLICY` hit and an `ET MALWARE` hit on the same TLS session). With `flow_id`
alone the second, more serious detection would be "deduplicated" into the first and never
enriched or scored. Including the signature keeps distinct detections distinct, and a
redelivered EVE line still deduplicates.

### Consequences

- 👍 Re-sent EVE lines and CEF events with `externalId` deduplicate exactly.
- 👍 The keyword table is one screen long and covered by tests; changing a category is a one-line diff.
- 👎 **Beaconing is not collapsed for Suricata**: each beacon is a new flow, hence a new
  `flow_id`, hence a new alert. ADR-0012's "one alert with a counter for a beaconing host"
  applies to sources _without_ a stable id (fallback fingerprint over title + indicators).
- 👎 Keyword classification is coarse. "ET MALWARE Cobalt Strike Beacon" becomes
  `command_and_control` (the C2 rule matches "beacon" before the malware rule): defensible,
  but a learner should know the order matters.
- ⚖️ A CEF line without a time gets `occurredAt = receivedAt`, so its TTD is 0 in MTTD
  ([ADR-0026](0026-mttd-mttr-definitions.md)). This is visible: the raw line is kept.

## Pros and cons of the options

### `sourceAlertId = flow_id`

- 👍 Matches the original brief literally.
- 👎 Merges different signatures on the same flow (a correctness bug, see above).

### No `sourceAlertId` for Suricata

- 👍 Beacons collapse into one alert via the fallback fingerprint.
- 👎 Two genuinely separate incidents with the same signature between the same hosts would merge
  while the first is still open. Revisit trigger below.

### Rejecting CEF lines without a time

- 👍 No invented timestamps.
- 👎 Many appliances omit `rt`; rejecting them would drop real detections.

## What would make us revisit this

- Analysts complain about Suricata beacon floods: make the Suricata identity configurable per
  webhook source (`flow` vs `signature+src+dst`), or add a time-windowed dedup (ADR-0012's revisit trigger).
- A vendor whose CEF severity semantics differ from ArcSight's (add a per-source override).

## Further reading

- Suricata documentation, _EVE JSON Output_ (docs.suricata.io)
- Micro Focus, _ArcSight Common Event Format (CEF) Implementation Standard_, rev. 25
- Emerging Threats rule metadata conventions (`mitre_*` keys)
