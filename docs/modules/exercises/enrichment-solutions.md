# Enrichment: exercise solutions

Exercises are in the [enrichment module guide](../enrichment.md#exercises). Try them first.
The code in solutions 2 and 3 was run against the real primitives before being written down.

## 1. Read the stack

Each attempt is cut at `timeoutMs` = 1000 ms, because the provider needs 1.5 s. The
`TimeoutError` is transient, so retry tries again, after a full-jitter sleep of
`random() · min(cap, base · 2^i)`:

| Step      | Duration (worst case)       |
| --------- | --------------------------- |
| attempt 1 | 1000 ms → timeout           |
| backoff 1 | ≤ min(1000, 50·2⁰) = 50 ms  |
| attempt 2 | 1000 ms → timeout           |
| backoff 2 | ≤ min(1000, 50·2¹) = 100 ms |
| attempt 3 | 1000 ms → timeout, give up  |

Worst case **≈ 3150 ms**, and the result has `status: "timeout"` (the last error is rethrown
unchanged, then mapped by `statusForError`).

The breaker sits **outside** retry, so this whole sequence counts as **one** failure. With
`minimumCalls` = 10 and a threshold of 50 %, the breaker opens after the **10th** such
lookup. From then on, lookups fail in microseconds with `circuit_open` for 10 s. That's
the point: during an outage each lookup costs nothing instead of 3 s.

## 2. Find the double count

With retry outside the breaker, every _attempt_ is recorded as an outcome, so one logical
call contributes three failures. The test below opens the breaker after **4** logical
calls in the wrong order, versus **10** in the ADR order. It also hides a second bug: once
the breaker is open, retry keeps calling `breaker.execute` (which fails fast, so the harm is
small), but the retry budget is spent on `CircuitOpenError`s.

```ts
it('retry outside the breaker counts every attempt', async () => {
  const scheduler = new VirtualScheduler();
  const options = {
    failureRateThreshold: 0.5,
    windowSize: 10,
    minimumCalls: 10,
    cooldownMs: 10_000,
    halfOpenMaxCalls: 1,
    scheduler,
  };
  const failing = () => Promise.reject(new TransientProviderError('503'));

  const opensAfter = async (call: (b: CircuitBreaker) => Promise<unknown>) => {
    const breaker = new CircuitBreaker(options);
    let calls = 0;
    while (breaker.state === 'closed') {
      calls += 1;
      const p = call(breaker).catch(() => undefined);
      await scheduler.runAll();
      await p;
    }
    return calls;
  };
  const retryOpts = { maxAttempts: 3, baseMs: 0, capMs: 0, scheduler };
  expect(await opensAfter((b) => b.execute(() => retry(failing, retryOpts)))).toBe(10); // ADR order
  expect(await opensAfter((b) => retry(() => b.execute(failing), retryOpts))).toBe(4); // wrong order
});
```

It violates the ADR-0014 rationale "one logical call counts once toward the failure rate":
the breaker would open about 2.5× too eagerly, and its threshold would silently depend on
`maxAttempts`.

## 3. Abort on shutdown

```ts
it('an aborted enrichment returns promptly without blaming the provider', async () => {
  const scheduler = new VirtualScheduler();
  const provider = new ResilientEnricher(
    createReputationEnricher({ latencyMs: 5_000, scheduler }),
    DEFAULT_RESILIENCE,
    { scheduler },
  );
  const service = new EnrichmentService([provider], { scheduler });
  const shutdown = new AbortController();

  const pending = service.enrich(
    { indicators: [{ type: 'ipv4', value: '203.0.113.66' }] },
    { signal: shutdown.signal },
  );
  await scheduler.advance(10);
  shutdown.abort(new AbortedError('shutting down'));

  const [result] = await pending;
  expect(result?.status).toBe('error'); // a gap, recorded honestly
  expect(result?.error).toBe('shutting down');
  expect(provider.breaker.failureRate).toBe(0); // the caller gave up; the provider is fine
  expect(scheduler.pendingTimers).toBe(0); // timeout and latency timers both cancelled
  expect(scheduler.now()).toBe(10); // returned at once, not after 1 s
});
```

Why it works: the caller's signal flows into the bulkhead (a queued call leaves the queue),
retry (no new attempt, the backoff sleep ends), and `withTimeout`, which aborts the
provider's signal with the caller's reason and clears its timer. The breaker's default
`isFailure` ignores `AbortedError`, so the breaker records nothing. The mock's simulated
latency is an abortable `sleep`, just as a real HTTP client would be.

## 4. A new provider (`passive-dns`)

Passive DNS returns facts (`resolvedIps`, `firstSeen`, `lastSeen`), not a reputation, so
reusing `kind: 'reputation'` would be lying to scoring. Steps, in order:

1. `packages/shared-schema/src/enrichment.ts`: add
   `PassiveDnsDataSchema = z.object({ kind: z.literal('passive_dns'), resolvedIps: z.array(z.string()), firstSeen, lastSeen })`
   to the `EnrichmentDataSchema` discriminated union (additive).
2. `packages/enrichers/fixtures/passive-dns.json` (only `.example`/`.test` domains and
   documentation IPs) and `src/mock/passive-dns.ts` built with `createMockEnricher`.
   Export it, and add it to `createMockEnrichers` if it should be on by default.
3. Tests in `packages/enrichers/test/mocks.test.ts` (keep coverage ≥ 85 %).
4. `apps/api/src/modules/enrichment/adapters/providers.ts` picks it up via `createMockEnrichers`.
5. If rules should use it: `scoring/domain/evaluation-context.ts` (e.g.
   `enrichment.passiveDns.newlyObserved`), plus `ENRICHMENT_SUMMARY_KEYS` and the table in `docs/modules/scoring.md`.
6. Update `GET /enrichment/providers` expectations in `test/unit/enrichment/http.test.ts`,
   and regenerate `openapi.json` (the data union changed).

## 5. Inbox retention

A row in `enrichment_processed_events` exists to stop a **redelivery** of the same event.
Redeliveries come from two places:

- **The relay re-dispatching** an event it already enqueued (crash between `addBulk` and
  `UPDATE dispatched_at`). BullMQ drops the duplicate job **as long as the original job id
  is still known**, i.e. for `removeOnComplete.age` = 24 h after completion.
- **BullMQ retrying** a failed job: this happens only while the job is alive (retries finish
  within minutes).

After the job id has been forgotten, a re-dispatch would create a **new** job and the inbox
row is the only guard left. Since `dispatched_at` is set in the same relay transaction, a
re-dispatch can only happen shortly after the original. So rows older than
`max(removeOnComplete.age, relay crash window)` plus a margin are safe to delete:

```sql
DELETE FROM enrichment_processed_events WHERE processed_at < now() - interval '7 days';
```

Seven days is several times the 24 h job retention. If someone raises `removeOnComplete`,
the purge horizon must follow. That coupling belongs in a comment next to both settings.
