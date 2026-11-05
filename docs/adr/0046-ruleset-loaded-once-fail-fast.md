# ADR-0046: Load the scoring ruleset once at startup and fail fast if invalid

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** architecture, ops

## Context and problem statement

[ADR-0015](0015-explainable-rule-based-scoring.md) puts scoring rules in a versioned YAML
file. We still had to decide when it is read, what happens if it's broken, and whether it
can change while the process runs.

A broken ruleset is dangerous in a quiet way. If a typo makes the `critical-asset` rule
never match, nothing crashes: scores are just lower, real incidents sink in the queue,
and nobody notices for days.

## Decision drivers

- A broken ruleset must be **impossible to run**, not merely logged.
- Every stored score must name the ruleset version that produced it.
- Simple operations: no hot-reload races between API and worker processes.

## Considered options

1. **Load once at composition time, validate fully, throw on any problem.**
2. Load at startup, and hot-reload on file change.
3. Store rulesets in the database and edit them through the API.

## Decision outcome

**Chosen option 1.** `createScoringModule` reads `CONFIG_DIR/SCORING_RULESET_FILE`
(default `config/scoring/ruleset.v1.yaml`), parses it (YAML aliases disabled) and
validates it with `parseRuleset`:

- the `RulesetSchema` from `@spine/shared-schema` (shape, ranges, all five severities in the baseline);
- unique rule IDs;
- every `matches` pattern passes `isSafePattern` (ReDoS guard, [ADR-0013](0013-playbook-dsl.md));
- condition nesting ≤ 16;
- every field path starts with a real context key ([ADR-0043](0043-scoring-evaluation-context.md)).

Any problem throws `InvalidRulesetError`, with **all** the problems listed, before the HTTP
server listens or the worker consumes. The orchestrator sees a crash-looping container
with a readable message. A unit test (`test/unit/scoring/http.test.ts`) builds the module
from the shipped file, so CI fails if the committed ruleset is invalid.

Changing rules means editing the file (or adding `ruleset.v2.yaml` and pointing the env
var at it) and restarting. A change in a rule's meaning gets a new `version`.

### Consequences

- 👍 A typo can't reach production silently.
- 👍 API and worker always agree on the version, because they load the same file at start.
- 👎 Changing rules needs a restart (a rolling one in practice).
- 👎 The runtime image must ship `apps/api/config/` next to the bundle, since the YAML is
  read from disk and not bundled. That is noted for the infra workstream.

## Pros and cons of the options

### Hot reload

- 👍 No restart.
- 👎 API and worker can briefly disagree. A half-written file could be read. "What
  ruleset scored this?" gets harder to answer.

### Database-stored rulesets

- 👍 Editable from the console, with history.
- 👎 Needs an authoring UI, validation endpoints and RBAC for a feature v0.1 doesn't need.
  YAML in Git already gives review, diff and history.

## What would make us revisit this

- Detection engineers need to tune rules more than weekly → database-backed rulesets with
  an approval workflow, still validated with the same `parseRuleset`.

## Further reading

- Jim Shore, _Fail Fast_ (IEEE Software, 2004)
- The Twelve-Factor App, factor IX "Disposability"
