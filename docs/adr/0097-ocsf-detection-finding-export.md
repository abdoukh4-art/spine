# ADR-0097: Export alerts as OCSF 1.9.0 Detection Findings, validated against a generated contract

- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** maintainers
- **Tags:** interoperability, api

## Context and problem statement

Spine's canonical alert (ADR-0011) is "ECS/OCSF-inspired" but its own shape. The tools a SOC
feeds findings into (security data lakes such as Amazon Security Lake, SIEMs, other SOARs) increasingly
speak the **Open Cybersecurity Schema Framework** (OCSF). A Spine that can't hand an alert to the
rest of the stack in a standard format stays an island.

Two questions: which OCSF class and mapping, and how do we **prove** conformance without network
access in CI (the official schema server isn't reachable from Spine's build environment)?

## Decision drivers

- Conform to a **released** OCSF version, not a moving development branch.
- Every mapping choice written down, because OCSF leaves room for interpretation.
- Conformance proven by tests that run offline, against the official schema, not hand-written assumptions.
- Keep Spine's differentiator (the explainable score) in the export.

## Considered options

1. **Detection Finding (class 2004) from OCSF 1.9.0**, served at `GET /alerts/:id/ocsf`, validated in
   tests against a **contract generated from the official schema** by a committed script.
2. Security Finding (class 2001): deprecated in favour of the specific finding classes.
3. Incident Finding (2005): models an incident (a case), not one detection.
4. Validate with hand-written expectations only.

## Decision outcome

**Option 1.** OCSF 1.9.0 is the latest release (2026-08-03; `main` is `1.10.0-dev`).
`scripts/ocsf-contract.mjs` reads a checkout of `ocsf/ocsf-schema` at tag `1.9.0` and writes
`apps/api/test/fixtures/ocsf/detection_finding-1.9.0.contract.json`. That covers every attribute of
the class and of the objects it uses (inheritance resolved, enums merged with the dictionary,
class identity pinned, observable `type_id`s assembled the way the schema server does), with the
source commit recorded. `validateOcsf()` checks required attributes, unknown attributes, primitive
types and enum values. A property test maps 300 random alerts (every status, severity and indicator
type; with and without host, score and tactic) and requires zero violations.

| Spine                                                            | OCSF                                                                                             | Why                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| received by Spine                                                | `time`, `finding_info.created_time`                                                              | the finding's creation in the reporting system         |
| sensor's `occurredAt`                                            | `start_time`, `metadata.original_time`                                                           | keeps detection latency (MTTD) computable downstream   |
| severity (score-derived, else source)                            | `severity_id` (Informational 1 … Critical 5)                                                     | the one a SOC acts on                                  |
| score                                                            | `risk_score`, `risk_level_id`                                                                    | OCSF's numeric risk fields                             |
| `new` / `triaged`, `in_progress` / `false_positive` / `resolved` | `status_id` 1 / 2 / 3 Suppressed / 4                                                             | a false positive is suppressed, not fixed              |
| ATT&CK technique / tactic                                        | `finding_info.attacks[].technique` / `.tactic`                                                   | the standard place                                     |
| indicators, host name/IPs                                        | `observables` (Hostname 1, IP 2, User 4, Email 5, URL 6, Hash 8); `device` (`type_id` 0 Unknown) | OCSF has no domain type: `hostname_t` covers DNS names |
| alert id / source id / source product                            | `finding_info.uid` / `uid_alt` / `product`                                                       | stable identity, plus the original detector            |
| score explanation, playbook runs                                 | `unmapped.spine`                                                                                 | no OCSF home for an explainable score                  |
| raw payload                                                      | not exported                                                                                     | size and data minimisation                             |

### Consequences

- 👍 Any OCSF consumer can ingest Spine findings; mapping choices are documented and tested.
- 👍 The validator caught two real issues while building this: base_event's placeholder `class_uid`
  enum (the generator now pins the class identity, as the OCSF compiler does), and a deliberately
  wrong observable type in a mutation check.
- 👎 One alert per request; a bulk/streaming export (NDJSON or Parquet for a data lake) is future work.
- 👎 The contract is a snapshot: moving to OCSF 1.10 means regenerating it and re-running the tests.
- ⚖️ The validator covers types, enums and required attributes, not every OCSF constraint (e.g.
  `at_least_one` rules, profiles). It's a strong check, not the official validator.

## What would make us revisit this

- A consumer needs batches → `GET /ocsf/detection-findings?from&to` (NDJSON) or a Parquet export job.
- OCSF 1.10 is released → regenerate the contract, re-check the mapping table.
- Cases need exporting → Incident Finding (2005) for cases.

## Further reading

- OCSF schema repository, tag `1.9.0`: `events/findings/detection_finding.json`
- OCSF documentation: "Understanding OCSF" (categories, classes, profiles, observables)
