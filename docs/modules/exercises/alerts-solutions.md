# Alerts: exercise solutions

Exercises are in the [alerts module guide](../alerts.md#exercises). Try them first.

## 1. NULL trap

`walks score DESC NULLS LAST…` and `walks score ASC with NULLs still last` fail (we ran exactly
this mutation while building the module). Two things go wrong:

- When the cursor sits on a number `k`, the next page should include **all** unscored rows
  (they sort after every number). `(score, id) < (k, id)` evaluates to `NULL` (unknown) for a
  row with `score IS NULL`, and `WHERE` drops unknown rows, so every unscored alert is skipped.
- When the cursor sits on an unscored row, `k` is `null`, and `(score, id) < (NULL, id)` is
  unknown for every row: the page after the first unscored alert is empty.

So the first unscored alert is either never reached (cursor on a number) or is the last thing
you ever see (cursor on it). The explicit three-branch predicate in ADR-0037 handles both.

## 2. Effective severity

A score of 15 maps to `informational` (`severityFromScore`). The projection writes
`severity = 'informational'`; `source_severity` stays `high`. The effective severity is
`coalesce(severity, source_severity) = 'informational'`, so `?severity=informational` finds
it and `?severity=high` does not. The summary shows `sourceSeverity: "high"`,
`severity: "informational"`, `score: 15`. Before it was scored, `?severity=high` found it.

## 3. MTTR query

```sql
SELECT count(*)                                                            AS count,
       avg(extract(epoch FROM resolved_at - received_at))                  AS mean_seconds,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY resolved_at - received_at) AS p50,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY resolved_at - received_at) AS p90,
       (SELECT count(*) FROM alerts
         WHERE received_at >= $1 AND received_at < $2
           AND status NOT IN ('resolved', 'false_positive'))               AS open_count
  FROM alerts
 WHERE received_at >= $1 AND received_at < $2
   AND status IN ('resolved', 'false_positive');
```

`percentile_disc` is the nearest-rank method ADR-0026 requires. You need `status` because of
ADR-0036: a **reopened** alert is open but keeps its first `resolved_at`. Filtering on
`resolved_at IS NOT NULL` alone would count it as closed. (The Metrics module must do this
through the Alerts public API or events, not by querying this table: the SQL is for understanding.)

## 4. Case closing

In `CasesService.update`, when `status` changes to `closed`, inside the **same** transaction:
read the case's alert ids (`alertIdsByCase`), and for each open one apply the same logic as
`AlertsService.update` (lock, `planStatusChange(…, 'resolved')`, update, emit
`alert.status_changed` with the analyst as actor). Extract that logic into a method that takes a
transaction executor so both services can call it; don't call `setStatus` (it opens its own
transaction). Alerts already closed are a `noop` thanks to `planStatusChange`, and their first
`resolvedAt` is kept. Decide (and write an ADR) whether `false_positive` alerts should stay
`false_positive`: they should, since "resolved" would change their meaning. Also decide whether
reopening a case reopens its alerts (probably not: reopening is a per-alert decision).
