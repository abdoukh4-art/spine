# Tutorial 01: Write a scoring rule

**Goal:** teach Spine's scoring engine that _data leaving through a Tor exit node_ is worse
than either fact on its own, and see the new factor show up in an alert's explanation.

**You will learn:** the predicate language ([ADR-0013](../adr/0013-playbook-dsl.md)), the
evaluation context, how additive explainable scoring works ([ADR-0015](../adr/0015-explainable-rule-based-scoring.md)),
and test-first rule authoring. **Time:** ~30 minutes. **Prerequisites:** `pnpm install` done;
you've read the [scoring module guide](../modules/scoring.md).

> Every code block below was run against the real code while writing this tutorial
> (red, then green), so if something doesn't behave as described, that's a bug. Please open an issue.

## 1. Understand what a rule can see

A rule's `when` is evaluated against a read-only object `{ alert, enrichment }`:

- `alert` is the canonical alert (`alert.category`, `alert.host.hostname`, `alert.mitre.tacticId`…).
- `enrichment` is a **summary** built from the provider results by
  `apps/api/src/modules/scoring/domain/evaluation-context.ts` (`verdicts`, `maliciousIndicators`,
  `asset.criticality`, `assetTags`, `geo.isTor`, `geo.torIps`, `failedProviders`…).

The summary exists so that rules stay one line long. Without it you'd have to write
"find the result whose provider is geo and whose status is ok, then read data.isTor". The full
list of paths is in the module guide's _Evaluation context_ table.

**Why a closed language instead of JavaScript?** Rules are config that analysts edit. A
`{field, op, value}` predicate can't loop forever, can't read the filesystem and can't be
injected; ADR-0013 explains the `vm` sandbox that we rejected.

## 2. Write the failing test first

Create `apps/api/test/unit/scoring/exfiltration-over-tor.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuleset } from '../../../src/modules/scoring/adapters/ruleset-loader.js';
import { score } from '../../../src/modules/scoring/domain/engine.js';
import { results, testAlert } from './fixtures.js';

// The REAL ruleset file, exactly as production loads it (schema + safety validation).
const ruleset = loadRuleset(
  path.resolve(import.meta.dirname, '../../../config/scoring/ruleset.v1.yaml'),
);
const now = new Date('2026-10-28T10:00:02.000Z');

describe('rule: exfiltration-over-tor', () => {
  it('adds points when data leaves through a Tor exit node', () => {
    const explanation = score(
      testAlert({ category: 'exfiltration' }),
      [results.geo('198.51.100.77', 'DE', true)], // a Tor exit node
      ruleset,
      now,
    );
    const factor = explanation.factors.find((f) => f.ruleId === 'exfiltration-over-tor');
    expect(factor).toMatchObject({ points: 15, evidence: '198.51.100.77' });
  });

  it('does not fire for exfiltration without Tor', () => {
    const explanation = score(
      testAlert({ category: 'exfiltration' }),
      [results.geo('203.0.113.66', 'NL', false)],
      ruleset,
      now,
    );
    expect(explanation.factors.map((f) => f.ruleId)).not.toContain('exfiltration-over-tor');
  });
});
```

Run it and **watch it fail**:

```bash
pnpm --filter @spine/api exec vitest run --project unit test/unit/scoring/exfiltration-over-tor.test.ts
```

```
 × adds points when data leaves through a Tor exit node
 Tests  1 failed | 1 passed (2)
```

The second test already passes, and that's fine: it's a _guard_. It will catch a rule that's
too broad (e.g. one that forgets the Tor condition).

## 3. Add the rule

Open `apps/api/config/scoring/ruleset.v1.yaml` and add, under the `category-specific` section:

```yaml
- id: exfiltration-over-tor
  description: Data exfiltration through a Tor exit node (an anonymized destination)
  when:
    all:
      - { field: alert.category, op: eq, value: exfiltration }
      - { field: enrichment.geo.isTor, op: eq, value: true }
  points: 15
  evidenceField: enrichment.geo.torIps
```

Things to notice:

- **`all`** is a logical AND. The existing `tor-exit-node` rule already gives +10 for any Tor
  traffic. Additive scoring can't express "A _and_ B is worse than A + B" on its own, so you
  write the combination as its own rule (the "interactions" consequence in ADR-0015).
- **`evidenceField`** decides what the analyst sees in the _Evidence_ column. Without it the
  value of the first condition's field is quoted, here `exfiltration`, which explains nothing.
- **`points: 15`** is a judgement call. Keep weights on a scale analysts can reason about:
  a malicious verdict is +30, a critical asset +20.

Run the test again:

```
 Tests  34 passed (34)        # the whole scoring suite, including your 2 tests
```

## 4. Prove the ruleset is still valid

The ruleset is validated **when the process starts** (ADR-0046): schema, unique IDs, safe
regexes and field paths. The `ruleset.test.ts` suite loads the shipped file, so the full unit
run already checked yours. Try breaking it to see the protection work. Change
`enrichment.geo.isTor` to `enrichment.goe.isTor` and load the ruleset:

```
InvalidRulesetError: invalid scoring ruleset:
  - rules.12 (exfiltration-over-tor): unknown field "enrichment.goe.isTor"
    (must start with alert.<field> or enrichment.<key>; see docs/modules/scoring.md)
```

A typo becomes a startup failure instead of a rule that silently never matches.

**But know the limit.** Validation checks the path's _first_ segment after `alert.` /
`enrichment.`. A typo deeper down (`enrichment.geo.isTorr`) is **not** caught: it loads fine and
simply never matches, because a missing field is never equal to anything. That's exactly why
you wrote the positive test in step 2 first: it fails for that typo, while the
negative ("does not fire") test would happily pass. Try it.

## 5. See it in the product

The ruleset is read once at startup, so restart the API and worker to load your change:

```bash
docker compose -f infra/docker-compose.yml --env-file .env up -d --build api worker
```

Then preview a score without storing anything:

```bash
TOKEN=$(curl -s -H 'content-type: application/json' \
  -d '{"email":"analyst@spine.test","password":"night-owl-demo-dana-2026"}' \
  http://localhost:8080/api/v1/auth/login | jq -r .accessToken)

curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://localhost:8080/api/v1/scoring/preview -d '{
    "alert": { "source": {"vendor":"Acme","product":"Proxy"}, "title": "Upload to anonymous host",
               "category": "exfiltration", "severity": "medium", "occurredAt": "2026-10-28T10:00:00Z" },
    "enrichments": [{ "provider": "geo", "indicator": {"type":"ipv4","value":"198.51.100.77"},
                      "status": "ok", "data": {"kind":"geo","country":"DE","isTor":true},
                      "durationMs": 1, "fetchedAt": "2026-10-28T10:00:01Z" }]
  }' | jq '.factors'
```

You'll see the baseline, `tor-exit-node` (+10) and your `exfiltration-over-tor` (+15).

## 6. Ship it like a professional

- Changing a rule's **meaning** means a new ruleset **version** (`ruleset.v2.yaml`, `version: 2`),
  because every stored score records the version it was computed with. Adding a rule to v1
  is fine while v1 is unreleased. After release, write v2.
- The PR description says _why_ the weight is 15, and links an incident or detection-engineering note.

## Check your understanding

1. Why does the `not` operator make "missing field" rules dangerous? (Hint: read the semantics
   comment at the top of `packages/shared-schema/src/condition-eval.ts`.)
2. Write a rule that **lowers** the score by 20 for alerts from `vuln-scanner01`. Which field
   would you use, and why is `enrichment.assetTags` better than `enrichment.asset.tags`?
   (The engineering journal for 2026-10-28 has the story.)
3. Property-based tests in `engine.test.ts` assert "adding a positive-point matching rule never
   lowers a score". What would have to change in the engine for that law to break?
