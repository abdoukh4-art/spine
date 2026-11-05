# ADR-0015: Explainable, additive rule-based scoring with versioned rulesets

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture

## Context and problem statement

Analysts must decide which alert to look at first. A score from 0 to 100 helps, but only
if analysts **trust** it, and they only trust it if they can see _why_ an alert scored 87.
Scores also drive automation (playbook triggers), so they must be deterministic and
auditable: the same alert under the same ruleset must always yield the same score.

## Decision drivers

- Explainability: every score lists its contributing factors (success metric S5).
- Determinism and reproducibility, with the ruleset version recorded with each score.
- Rules editable as config, reviewed like code.
- Testable with property-based tests.

## Considered options

1. **Additive weighted rules over a read-only context, clamped to [0, 100], with a versioned YAML ruleset**
2. A risk matrix (likelihood × impact lookup table)
3. ML model (e.g. gradient-boosted trees on historical dispositions)
4. Source-reported severity only

## Decision outcome

**Chosen option 1.**

```yaml
# apps/api/config/scoring/ruleset.v1.yaml
version: 1
baseline: { fromSeverity: { informational: 0, low: 10, medium: 25, high: 40, critical: 55 } }
rules:
  - id: malicious-indicator
    description: At least one indicator has a malicious reputation verdict
    when: { field: enrichment.verdicts, op: contains, value: malicious }
    points: 30
  - id: critical-asset
    description: Affected host is a critical asset
    when: { field: enrichment.asset.criticality, op: eq, value: critical }
    points: 20
  - id: credential-access-tactic
    description: Mapped to MITRE TA0006 (Credential Access)
    when: { field: alert.mitre.tacticIds, op: contains, value: TA0006 }
    points: 15
```

- `score = clamp(0, 100, baseline(severity) + Σ points of matching rules)`. Points may be
  negative (e.g. `-20` for a known-benign scanner).
- The output `ScoreExplanation` lists **every** factor: the baseline factor plus one per
  matched rule, each with `ruleId`, `description`, `points` and `evidence` (the actual
  value that matched). If only the baseline applies, the explanation says so explicitly.
- Severity is derived from the score using fixed bands: `0–19 informational`, `20–39 low`,
  `40–59 medium`, `60–79 high`, `80–100 critical`.
- Conditions reuse the **same predicate language** as playbooks ([ADR-0013](0013-playbook-dsl.md)),
  which means one interpreter, one test suite and one thing for analysts to learn.
- Rulesets are versioned files. Every stored score records `rulesetVersion`. Changing
  rules = new file + PR + ADR note in the ruleset changelog.
- Missing enrichment (provider timeout) simply doesn't match. The explanation includes a
  `data-gaps` note listing failed providers, so a low score is never silently "low because
  the provider was down".

### Consequences

- 👍 100 % explainable and deterministic. Easy to property-test (score ∈ [0,100];
  adding a positive-point rule never lowers a score; factors sum to the score before clamping).
- 👍 Detection engineers tune rules with plain YAML diffs.
- 👎 Additive scoring ignores interactions (A and B together being worse than A + B).
  Workaround: an explicit combined rule `{all:[A,B]}` with bonus points.
- 👎 Weights are expert judgment, not learned. A future ML score could run alongside as a _second opinion_.

## Pros and cons of the options

### Risk matrix

- 👍 Familiar to risk managers.
- 👎 Coarse (5×5 = 25 cells), and it needs separate likelihood/impact inputs we often don't have.

### ML model

- 👍 Can learn from analyst dispositions.
- 👎 Needs labelled data we don't have, is hard to explain, and drifts silently. A non-goal for v0.1.

### Source severity only

- 👍 Zero work.
- 👎 Every vendor's "high" means something different, and it ignores enrichment and asset context.

## What would make us revisit this

- More than ~50 rules makes additive interactions hard to reason about → consider rule groups with caps.
- Labelled disposition data exists (more than 10 k closed alerts) → evaluate an ML "second opinion" score.

## Further reading

- _The Pyramid of Pain_, David Bianco (why indicator types differ in value)
- Google SRE Workbook, ch. on _alerting on SLOs_ (for the "signal vs noise" mindset)
