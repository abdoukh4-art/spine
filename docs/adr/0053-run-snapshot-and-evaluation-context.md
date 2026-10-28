# ADR-0053: Runs carry an alert snapshot; conditions see an enrichment summary

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** architecture, data

## Context and problem statement

Branch conditions and templates read a context `{alert, score, enrichment, steps, run}`
([ADR-0013](0013-playbook-dsl.md)). Where does that data come from when a run resumes
hours later in another process, and what shape does `enrichment` have? Raw enrichment
results are a list of `{provider, indicator, verdict…}`, and the closed predicate
language cannot filter a list ("is any _URL_ malicious?").

## Decision drivers

- Runs must be replayable: the same events must give the same decisions forever.
- Modules must not read each other's tables ([ADR-0002](0002-hexagonal-modular-monolith.md)).
- Common SOC questions ("malicious URL or sender?") must be expressible without adding
  operators to the predicate language.

## Considered options

1. **Snapshot `{alert, score, enrichments}` into the `run.started` payload; build the context from the log only; expose `enrichment` as a summary `{results, verdicts.<indicatorType>[], malicious[], suspicious[]}`.**
2. Query the alerts/enrichment/scoring public APIs at each step.
3. Add list-filtering operators (`any_where`) to the predicate language.

## Decision outcome

**Chosen option 1.**

- Automatic runs take the snapshot from the `alert.scored` payload (which carries it for
  exactly this reason, see the event catalog). Manual runs ask the `AlertSnapshotGateway`
  port once, at creation.
- `enrich` and `score` steps refresh the context: their outputs are `{enrichments}` and
  `{score}`, and the latest one wins. Fresh enrichment results replace older ones per
  `(provider, indicator)`; others are kept.
- `enrichment.verdicts.url` → e.g. `['malicious','benign']`, so
  `{field: enrichment.verdicts.url, op: contains, value: malicious}` reads naturally.
  `enrichment.malicious` lists indicator values with any malicious verdict.
- Score fields are addressed as `score.score` (the `ScoreExplanation` field). The example
  in ADR-0013 says `score.value`; that was a typo in the example, the schema always had `score`.

### Consequences

- 👍 Replays never depend on another module's current state; a run's decisions are
  explainable from its own timeline.
- 👍 No new operators; the interpreter stays small and property-tested.
- 👎 The `run.started` payload duplicates alert data (a few KB per run). Accepted, like the
  event catalog's snapshot rule.
- 👎 Step IDs are kebab-case but template and field paths only allow `[A-Za-z0-9_]`, so
  `steps.<id>` is only addressable for IDs without hyphens. The shipped playbooks name
  steps referenced by templates accordingly (`block`, `ticket`). See the exercises.

## Pros and cons of the options

### Query other modules at each step

- 👍 Always the freshest data.
- 👎 Non-deterministic replays, and a hidden runtime coupling to three modules.

### List-filtering operators

- 👍 More expressive.
- 👎 Grows the attack surface and the interpreter for one common case a summary covers.

## What would make us revisit this

- Authors need per-provider conditions → add `enrichment.byProvider.<name>` to the summary.
- Hyphenated step IDs in paths become a frequent pain → allow `-` in path segments
  (a shared-schema change that also affects scoring).

## Further reading

- Martin Fowler, _Event-Carried State Transfer_ (in "What do you mean by Event-Driven?", 2017)
