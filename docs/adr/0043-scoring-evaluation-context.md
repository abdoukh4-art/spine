# ADR-0043: Scoring rules see a summarized evaluation context, not raw results

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** architecture

## Context and problem statement

Scoring rules are conditions in the shared predicate language
([ADR-0013](0013-playbook-dsl.md)), evaluated against a context object by dotted paths.
Rule authors are detection engineers, not developers. The raw input is an `Alert` plus a
list of `EnrichmentResult`s: one per (provider, indicator), each with a status, an optional
verdict and a provider-specific `data` payload.

The predicate language has no filtering or quantifiers. "Is the asset critical?" over raw
results would have to be written as
`enrichments.data.criticality contains critical`. That relies on array flattening, it
silently mixes providers, and it has no way to say "the most critical asset".

## Decision drivers

- Rules readable by non-developers.
- No new operators in the predicate language (its small size is a security property).
- Deterministic output, for reproducible scores and stable evidence text.
- One documented place that lists every path a rule may use.

## Considered options

1. **Summarize** enrichment into a fixed, documented `enrichment.*` shape before evaluation.
2. **Expose raw results** and extend the predicate language with filters/quantifiers.
3. **Expose raw results**, and let rules use array flattening as-is.

## Decision outcome

**Chosen option 1.** The context is `{ alert, enrichment }`, where `alert` is the canonical
alert snapshot and `enrichment` is built by `buildEvaluationContext`:

| Path                                                                                 | Meaning                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `enrichment.verdicts`                                                                | distinct verdicts of successful lookups, most severe first |
| `enrichment.maxReputationScore`                                                      | highest reputation score, or null                          |
| `enrichment.maliciousIndicators` / `…Types`                                          | values / types of indicators judged malicious              |
| `enrichment.suspiciousIndicators`                                                    | values of indicators judged suspicious                     |
| `enrichment.reputationTags`                                                          | union of reputation tags                                   |
| `enrichment.asset` (`.criticality`, `.owner`, `.businessUnit`, `.hostname`, `.tags`) | the **most critical** asset found, or null                 |
| `enrichment.geo` (`.countries`, `.asns`, `.isTor`, `.torIps`)                        | geo facts over the alert's public IPs                      |
| `enrichment.failedProviders`                                                         | providers with at least one failed lookup                  |

Every list is de-duplicated and sorted. The full reference, with examples, is in the
[scoring module guide](../modules/scoring.md#evaluation-context).

**Load-time path checking.** `parseRuleset` rejects any rule whose field (or
`evidenceField`) doesn't start with `alert.<a real Alert field>` or
`enrichment.<a key above>`. A typo such as `enrichments.verdicts` would otherwise never
match, and the rule would be silently dead. With the check, the process refuses to start
([ADR-0046](0046-ruleset-loaded-once-fail-fast.md)).

### Consequences

- 👍 Rules read like the analyst's question: `enrichment.asset.criticality eq critical`.
- 👍 Provider names don't leak into rules: a second reputation provider feeds the same
  `verdicts` and `reputationTags` with no rule change.
- 👍 Determinism: sorted lists give stable evidence strings, so ADR-0042's change
  detection doesn't flap.
- 👎 A new kind of fact needs code (a new summary field), not just YAML. That's deliberate:
  it's reviewed, documented and tested in one place.
- 👎 The summary drops detail: rules can't say "malicious **and** from provider X". No
  such need has come up yet.

## Pros and cons of the options

### Extend the predicate language

- 👍 Maximum flexibility.
- 👎 Bigger attack and bug surface in an interpreter that playbooks share. Harder for
  analysts to learn.

### Raw results + flattening

- 👍 No code.
- 👎 Fragile and unreadable. "Most critical asset" can't be expressed at all.

## What would make us revisit this

- Rule authors ask for a fact the summary lacks more than twice a quarter → consider
  exposing raw results under `enrichment.results` alongside the summary.

## Further reading

- Martin Fowler, _Domain-Specific Languages_ (2010), on keeping a DSL's semantic model small
