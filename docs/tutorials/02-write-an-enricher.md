# Tutorial 02: Write an enricher

**Goal:** add an **internal denylist** provider: indicators your SOC has confirmed as malicious
during past incidents. Then watch Spine wrap it in timeouts, retries, a circuit breaker and a
bulkhead without your provider knowing any of that exists.

**You will learn:** the `Enricher` port (hexagonal architecture, [ADR-0002](../adr/0002-hexagonal-modular-monolith.md)),
the error contract that makes resilience work, `AbortSignal`, and where a provider is wired in.
**Time:** ~45 minutes. **Prerequisites:** [tutorial 01](01-write-a-scoring-rule.md) (you'll reuse
the scoring step at the end); the [enrichment module guide](../modules/enrichment.md).

> The code below was rehearsed against the real repository while writing this tutorial
> (4 tests passing, type-check clean).

## 1. Read the port before writing an adapter

Open `packages/enrichers/src/enricher.ts`. The whole contract is four members:

```ts
export interface Enricher {
  readonly name: string; // stable: appears in results, metrics, logs
  readonly indicatorTypes: readonly IndicatorType[];
  supports(indicator: Indicator): boolean; // pure and cheap
  lookup(indicator: Indicator, context: LookupContext): Promise<LookupOutcome>;
}
```

The comments state the **error contract**, and it matters more than the interface itself:

- `notFound()` means "I answered, I just don't know it". It's a _success_, and it must not
  count against the circuit breaker. If "unknown IP" were an error, a provider that rarely
  knows anything would open its breaker under normal traffic.
- Throw `TransientProviderError` for failures worth retrying (rate limited, 503, connection reset).
- Throw anything else for permanent failures. Those aren't retried, because retrying a 400 just
  triples the load and still fails.
- Honour `context.signal`. When the per-attempt timeout fires, the signal aborts, and real
  providers pass it to `fetch(url, { signal })` so the abandoned request actually stops.

**What's NOT in the interface:** timeouts, retries, breakers, concurrency limits. Those are the
_same_ for every provider, so they live once in `ResilientEnricher` ([ADR-0014](../adr/0014-hand-written-resilience-primitives.md)).
Your adapter stays naive, and that is the point.

## 2. Test first

Create `packages/enrichers/test/internal-denylist.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createInternalDenylistEnricher } from '../src/internal-denylist.js';

const enricher = createInternalDenylistEnricher([{ type: 'domain', value: 'Evil.Example' }]);
const signal = new AbortController().signal;

describe('internal denylist enricher', () => {
  it('finds denylisted indicators regardless of case', async () => {
    const outcome = await enricher.lookup({ type: 'domain', value: 'evil.example' }, { signal });
    expect(outcome).toMatchObject({
      kind: 'found',
      verdict: 'malicious',
      data: { tags: ['internal-denylist'] },
    });
  });

  it('answers not_found (not an error) for anything else', async () => {
    expect(await enricher.lookup({ type: 'domain', value: 'cdn.example.com' }, { signal })).toEqual(
      {
        kind: 'not_found',
      },
    );
  });

  it('honours an aborted signal', async () => {
    const aborted = AbortSignal.abort(new Error('timeout'));
    await expect(
      enricher.lookup({ type: 'domain', value: 'evil.example' }, { signal: aborted }),
    ).rejects.toThrow('timeout');
  });

  it('only claims indicator types it can handle', () => {
    expect(enricher.supports({ type: 'username', value: 'jdoe' })).toBe(false);
  });
});
```

`pnpm --filter @spine/enrichers test` fails: the module doesn't exist yet.

## 3. Implement the adapter

Create `packages/enrichers/src/internal-denylist.ts`:

```ts
import type { Indicator, IndicatorType } from '@spine/shared-schema';
import {
  found,
  notFound,
  type Enricher,
  type LookupContext,
  type LookupOutcome,
} from './enricher.js';
import { normalizeIndicator } from './targets.js';

const DENYLIST_TYPES: readonly IndicatorType[] = ['ipv4', 'ipv6', 'domain', 'url', 'sha256'];

/**
 * The SOC's own denylist: indicators the team has confirmed as malicious during past
 * incidents. Answers with a `reputation` payload, so existing scoring rules (and the
 * `internal-denylist` tag) work without any schema change.
 */
export function createInternalDenylistEnricher(entries: readonly Indicator[]): Enricher {
  const keys = new Set(entries.map((e) => key(normalizeIndicator(e))));
  return {
    name: 'internal-denylist',
    indicatorTypes: DENYLIST_TYPES,
    supports: (indicator) => DENYLIST_TYPES.includes(indicator.type),
    lookup: (indicator: Indicator, context: LookupContext): Promise<LookupOutcome> => {
      if (context.signal.aborted) return Promise.reject(context.signal.reason);
      if (!keys.has(key(normalizeIndicator(indicator)))) return Promise.resolve(notFound());
      return Promise.resolve(
        found(
          { kind: 'reputation', score: 100, verdict: 'malicious', tags: ['internal-denylist'] },
          'malicious',
        ),
      );
    },
  };
}

function key(indicator: Indicator): string {
  return `${indicator.type}:${indicator.value}`;
}
```

Design notes worth pausing on:

- **Normalization on both sides.** `normalizeIndicator` lower-cases domains and canonicalizes
  IPs. Without it, `Evil.Example` in the list would never match `evil.example` from an alert.
  Ingestion normalizes too (ADR-0032), but an adapter should never assume its input is clean.
- **Reuse an existing data kind.** `EnrichmentData` is a closed union (`reputation | geo | asset`)
  in `@spine/shared-schema`. Returning `kind: 'reputation'` means scoring, the console and the
  OpenAPI document all understand the result already. A new kind would be a contract change
  across three packages, so only do that when the data really is different.
- **No I/O, so no `await`.** A real provider would `await fetch(…, { signal: context.signal })`.

Export it from `packages/enrichers/src/index.ts` (`export * from './internal-denylist.js';`) and
re-run the tests: **4 passed**.

## 4. Wire it in, and get resilience for free

Providers are assembled in `apps/api/src/modules/enrichment/adapters/providers.ts`:

```ts
return [
  ...createMockEnrichers({ latencyMs, failureRate, seed }),
  createInternalDenylistEnricher([{ type: 'domain', value: 'update-check.test' }]),
].map((enricher) => new ResilientEnricher(enricher, resilience, hooks));
```

That `.map(… new ResilientEnricher …)` line is the whole integration. Your provider now has a
per-attempt timeout, retries with full jitter, its **own** circuit breaker and its **own**
bulkhead. A slow denylist can't starve the reputation lookups (that's the bulkhead), and the
console's `GET /enrichment/providers` lists it with its breaker state.

In a real deployment the denylist entries would come from config or a table, so the
composition root would read them. Never hard-code them in the adapter.

## 5. Make it count in the score

Back to tutorial 01: add a rule that gives the denylist its due weight.

```yaml
- id: internal-denylist
  description: Indicator is on the SOC's internal denylist (confirmed in a past incident)
  when: { field: enrichment.reputationTags, op: contains, value: internal-denylist }
  points: 25
```

Restart the stack (`docker compose -f infra/docker-compose.yml --env-file .env up -d --build api worker`),
send an alert containing `update-check.test`, and open it in the console: the enrichment table shows
an `internal-denylist` row, and _Why this score?_ shows your rule.

## 6. Watch the resilience work (optional, fun)

Set `ENRICHMENT_FAILURE_RATE=0.6` in `.env`, restart, and run `./scripts/demo.sh`. Then:

- The alert detail page lists failed lookups with status `error`/`circuit_open`, and the score
  explanation shows a **Data gaps** warning. A low score is never silently low because a provider was down.
- Grafana's Spine overview dashboard shows enrichment latency (p95) and circuit-breaker state per provider.

## Check your understanding

1. Your adapter returns `Promise.resolve(notFound())` for unknown indicators. What would happen
   to the circuit breaker under normal traffic if it threw an `Error('unknown')` instead?
2. Why does the bulkhead sit _outside_ the retry in the composition order
   (bulkhead → breaker → retry → timeout)? What breaks if you swap them?
3. Write a property test: "for any list of entries and any indicator, `lookup` never rejects
   unless the signal is aborted". Which generators from `fast-check` do you need?
