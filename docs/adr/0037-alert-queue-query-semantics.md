# ADR-0037: Alert queue queries: NULLS-LAST keyset cursors, effective severity, parent techniques

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** alerts workstream
- **Tags:** data, architecture

## Context and problem statement

`GET /alerts` is the analyst's queue. [ADR-0024](0024-api-conventions.md) mandates keyset
pagination. Three details are subtle enough to need a decision:

1. **Sorting by score.** Alerts are unscored (`score IS NULL`) for a few hundred ms after
   ingestion, or for longer if scoring is down. A cursor comparison like
   `(score, id) < (k, id)` is wrong around NULLs: in SQL, `NULL < 5` is _unknown_, so rows are
   silently skipped.
2. **Filtering by severity.** The `severity` column is derived from the score, so it is NULL
   until scoring runs. Should `?severity=critical` hide a critical alert whose scoring is late?
3. **Filtering by technique.** Should `?technique=T1059` find alerts mapped to `T1059.001`?

## Decision drivers

- No skipped or duplicated rows while paging, including across the scored/unscored boundary
  and while new alerts arrive.
- A broken scoring pipeline must not hide critical alerts from the queue.
- Use the indexes that exist (`alerts_score_idx`, GIN on `mitre_technique_ids`, trigram on title).

## Considered options

- Score order: **NULLS LAST in both directions** vs NULLS FIRST for ascending (matches a backward index scan).
- Severity filter: **`coalesce(severity, source_severity)`** vs `severity` only.
- Technique filter: **store parent ids too and use `@>`** vs a prefix match (`LIKE 'T1059%'`) over an unnested array.

## Decision outcome

- **Score ordering** is `ORDER BY score {dir} NULLS LAST, id {dir}` for both directions
  (unscored alerts always come last). The cursor `{k: score | null, id}` translates to:
  - `k` is a number: `score {<|>} k OR (score = k AND id {<|>} cursorId) OR score IS NULL`
  - `k` is null: `score IS NULL AND id {<|>} cursorId`

  The integration tests walk every page in both directions with page sizes 1 and 2 and
  compare with a single full query; replacing the predicate with a tuple comparison fails both.

- **receivedAt ordering** uses the row-value comparison `(received_at, id) < (k, id)` (never
  NULL). Timestamps are written by the application with millisecond precision, so the ISO
  string in the cursor is exact.
- A cursor is **bound to its sort mode**: a score cursor used with `sort=receivedAt` (or vice
  versa) is a `400`, not a confusing page.
- **Severity filter** uses the _effective_ severity `coalesce(severity, source_severity)`. It
  can't use `alerts_severity_idx`; at queue sizes (thousands of open alerts) this is fine.
- **Technique filter**: on insert, `mitre_technique_ids` stores each technique **and its parent**
  (`T1059.001` → `{T1059, T1059.001}`), and the filter is `mitre_technique_ids @> ARRAY[$t]`
  (GIN-indexed). The exact mapping stays untouched in the canonical JSON.
- **Free text** `q` is `title ILIKE '%…%'` with `%`, `_` and `\` escaped, served by the trigram index.
- **Source** `source` matches vendor _or_ product, case-insensitively.

### Consequences

- 👍 Paging is stable under inserts for `receivedAt` sorting (new rows land before the cursor).
- 👍 Unscored alerts stay visible under severity filters.
- 👎 Score-sorted paging is only as stable as the scores: if an alert is scored _while_ someone
  pages, it can move across the cursor and appear twice or not at all. Inherent to sorting on a
  mutable column; documented in the module guide.
- 👎 `order=asc&sort=score` can't use the `(score DESC NULLS LAST, id DESC)` index as a pure
  backward scan (that would be NULLS FIRST). Ascending score is a rare view; revisit if slow.

## Pros and cons of the options

### NULLS FIRST for ascending

- 👍 Index-friendly backward scan.
- 👎 "Lowest risk first" would start with a page of unscored alerts, which are not "low risk".

### Severity column only

- 👍 Index-friendly and simple.
- 👎 A scoring outage hides every new alert from severity-filtered views: the worst possible failure mode for a SOC queue.

### Prefix match for techniques

- 👍 No denormalization.
- 👎 Can't use the GIN index; needs `unnest` + `LIKE` per row.

## What would make us revisit this

- Queue sizes where the effective-severity filter shows up in slow-query logs (add an
  expression index on `coalesce(severity, source_severity)`).
- A need for tactic filtering (`mitre_tactic_ids` is already stored).

## Further reading

- Markus Winand, _Use The Index, Luke_: "Paging Through Results" and "NULLs in the ORDER BY"
- PostgreSQL docs, _Row Constructor Comparison_ and _GIN Indexes_
