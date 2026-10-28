# Scoring: exercise solutions

Exercises are in the [scoring module guide](../scoring.md#exercises). Try them first.
Solutions 1 and 2 were checked by running the engine and the interpreter.

## 1. Hand-score

Enrichment: the URL `http://evil.example/login` is `malicious` (score 95, tag `phishing`);
the IP `198.51.100.77` is `suspicious` (tag `tor-exit`) and geo says `isTor: true`; the
asset inventory lookup for the host timed out.

| Factor                        | Points | Evidence                    | Why                                                              |
| ----------------------------- | -----: | --------------------------- | ---------------------------------------------------------------- |
| `baseline`                    |     25 | `severity=medium`           | `fromSeverity.medium`                                            |
| `malicious-indicator`         |     30 | `http://evil.example/login` | `verdicts` contains `malicious`                                  |
| `tor-exit-node`               |     10 | `198.51.100.77`             | `geo.isTor`                                                      |
| `phishing-with-malicious-url` |     15 | `http://evil.example/login` | category `phishing` and `maliciousIndicatorTypes` contains `url` |
| `repeated-alert`              |     10 | `12`                        | `duplicateCount ≥ 10`                                            |
| **total**                     | **90** |                             | **critical**; `dataGaps: ["asset-inventory"]`                    |

`suspicious-indicator` does **not** fire: it requires that nothing is malicious. And
`critical-asset` can't fire, because the asset is unknown. That's exactly what `dataGaps`
warns about: the score could be higher once the inventory answers.

## 2. The `neq` trap

The interpreter makes **every** operator false on a missing value, `neq` included:

| Condition                                                              | no asset  | low   | high |
| ---------------------------------------------------------------------- | --------- | ----- | ---- |
| `{ field: enrichment.asset.criticality, op: neq, value: low }`         | **false** | false | true |
| `{ not: { field: enrichment.asset.criticality, op: eq, value: low } }` | **true**  | false | true |

- "Not low, **including unknown**" → the `not … eq` form.
- "An asset was found and it isn't low" → `neq` alone. Or, more explicitly:
  `{all: [{field: enrichment.asset, op: exists}, {field: enrichment.asset.criticality, op: neq, value: low}]}`.

They differ because `neq` asks a question _about a value_, while `not` negates the whole
answer. With no value, "is it ≠ low?" has no answer (false), but "is it not the case that
it's low?" is true. The semantics are chosen so a provider outage can never make a rule
fire by accident. Rules that _do_ want to fire on missing data must say so with `not`.

## 3. A combination rule

```yaml
- id: tor-credential-access
  description: Credential access from a Tor exit node (worse than either alone)
  when:
    all:
      - { field: enrichment.geo.isTor, op: eq, value: true }
      - { field: alert.mitre.tacticId, op: contains, value: TA0006 }
  points: 10
  evidenceField: enrichment.geo.torIps
```

```ts
it('tor-credential-access fires only when both hold', () => {
  const tor = results.geo('198.51.100.77', 'DE', true);
  const ids = (alert: Alert, e: EnrichmentResult[]) =>
    score(alert, e, rulesetWithTheNewRule, now).factors.map((f) => f.ruleId);
  const credAccess = testAlert({ mitre: [{ tacticId: 'TA0006', techniqueId: 'T1110' }] });
  const other = testAlert({ mitre: [{ tacticId: 'TA0007', techniqueId: 'T1087' }] });
  expect(ids(credAccess, [tor])).toContain('tor-credential-access');
  expect(ids(credAccess, [])).not.toContain('tor-credential-access');
  expect(ids(other, [tor])).not.toContain('tor-credential-access');
});
```

Since the change adds a rule, it belongs in `ruleset.v2.yaml` (see exercise 5).

## 4. A property of your own

```ts
it('a rule with negative points never raises the score', () => {
  fc.assert(
    fc.property(
      alertArb,
      enrichmentArb,
      rulesetArb,
      conditionArb,
      fc.integer({ min: -100, max: -1 }),
      (alert, enrichments, ruleset, when, points) => {
        const before = score(alert, enrichments, ruleset, now).score;
        const extra = { id: 'negative', description: 'n', when, points };
        const after = score(
          alert,
          enrichments,
          { ...ruleset, rules: [...ruleset.rules, extra] },
          now,
        ).score;
        expect(after).toBeLessThanOrEqual(before);
      },
    ),
  );
});
```

It holds for **any** condition, `not` included. Adding the rule either doesn't match
(raw unchanged) or adds a negative number (raw decreases), and `clamp` is monotonic, so
the clamped score can only stay or drop. What `not` changes is _when_ the rule matches, not
the direction of its effect. (Contrast this with a rule whose **points are changed** from
positive to negative: that one can lower the score of alerts it used to raise, which is
intended.)

## 5. Ruleset v2

1. Copy `ruleset.v1.yaml` to `ruleset.v2.yaml`, set `version: 2`, change `critical-asset`
   to `points: 25`, and add a changelog line in the header comment.
2. Point the deployment at it: `SCORING_RULESET_FILE=scoring/ruleset.v2.yaml`.
3. Tests: `ruleset.test.ts` loads the shipped file by path, so either parameterize it over
   both files or move it to v2. Update the expected numbers in the "realistic alerts"
   cases and in the integration tests that assert exact scores.
4. Write an ADR note, or a short ADR if the change is significant, saying _why_ 25.
5. Deploy: the ruleset is loaded at startup ([ADR-0046](../../adr/0046-ruleset-loaded-once-fail-fast.md)),
   so do a rolling restart of the API and workers.

Alerts already scored keep their **v1** row (`alert_scores` PK is `(alert_id, ruleset_version)`)
and nothing changes for them until they are re-enriched or re-scored. New alerts get v2
rows. `getForAlert` returns the most recently computed score, so after a re-enrich the v2
score becomes the visible one. To move every open alert to v2, run a deliberate backfill
that calls `scoreAndStore` for each. It publishes `alert.scored` only where the score
actually changed ([ADR-0042](../../adr/0042-scoring-publish-only-on-change.md)).
