# 2026-10-28 (night): Hardening: attack it, load it, and check the README

## Context

Phase 3 had three jobs: attack the integrated system as an adversary would, put it under load,
and make every public claim (README, tutorials, STATUS) true. The third job found as many
problems as the first two.

## 1. The security review: reading as an attacker

Method: list every trust boundary from the [threat model](../security/threat-model.md), and
for each one ask "what is the cheapest concrete thing I could do here?" rather than "is
control X present?". Findings and fixes are in the [review report](../security/review-2026-10-28.md).
Three are worth retelling.

- **F1: the most dangerous bug was in `.env.example`.** The code was fine; the example config
  ships published webhook secrets, and nothing stopped a production deploy from using them.
  Anyone who had read the repository could then sign webhooks, forge alerts and trigger
  playbooks. _Fix:_ `loadConfig` refuses placeholder secrets and `COOKIE_SECURE=false` when
  `NODE_ENV=production`. **Lesson:** your examples are part of your attack surface.
- **F3: a replay that changes a score.** HMAC plus a ±5 min timestamp window stops forgery,
  but not replay inside the window. Replays looked harmless (deduplication!) until I followed
  the data: each duplicate increments `duplicate_count`, which feeds the `repeated-alert`
  scoring rule. An attacker with one captured request could push an alert over a playbook
  threshold. _Fix:_ without an explicit `Idempotency-Key`, the verified signature becomes
  the key. _Mutation check:_ I removed the fix and confirmed the new integration test fails.
- **F4: a control the threat model overstated.** The audit log's append-only trigger can be
  disabled by the table owner, and the app connects as the owner. I didn't fix this in code
  (it changes the deployment model), but I corrected the threat model and wrote down the
  operational fix. **Lesson:** an honest ⚠️ beats a false ✅.

## 2. The load test: two bugs only load could find

Full numbers are in [performance.md](../operations/performance.md).

### Run 1: 6.3 % HTTP 500s at 200 alerts/s

_Observation:_ 1 904 responses were 500, not 503 (shed) or 429 (rate limited).
_Clue:_ the API logs were full of `OOM command not allowed when used memory > 'maxmemory'`
from Redis Lua scripts. _Experiment:_ `INFO memory` showed `used_memory_human:206.88M` against
`maxmemory_human:200.00M`, so Redis was full.
_Cause:_ two decisions that were each reasonable alone. BullMQ kept completed jobs (each a full
alert snapshot) for 24 h, and the rate limiter failed _closed_ when its store errored. Together
they meant "a full Redis returns 500s for every request". _Fix:_ bounded job retention and a
rate limiter that fails _open_ (the login throttle keeps its own in-memory fallback)
([ADR-0090](../adr/0090-load-test-fixes-retention-fail-open-poll-interval.md)).

### Runs 3 → 4: the pipeline was slow while idle

At a gentle 20 alerts/s, ingest → scored p95 was **1 011 ms**. Nothing was saturated, so the
time had to be spent _waiting_. Two outbox hops (ingested → enriched → scored), each polled
every 200 ms, give up to 400 ms of pure polling latency, plus queueing behind the batch.
_Experiment:_ poll every 50 ms. _Result:_ p95 **125 ms**.
**Lesson:** when latency is high and nothing is busy, look for a timer.

## 3. Making the README true

I wrote the README's demo story from the script and then checked each line against the running
system. One line was false: _"a VPN brute force → `brute-force-response`"_. The playbook never
ran. The CEF events said `"authentication failed after repeated failures"`, and the category
classifier only knew phrasings like `brute force`, `login fail` and `failed login`, so the alert was
categorized `other` and no playbook's trigger matched. _Fix:_ more phrasings in the
classifier, with tests. I re-ran the demo: the alert is now `credential_access` and the
playbook waits for approval.

The tutorials got the same treatment: I rehearsed each one against the code, and two claims
were corrected (a deep field-path typo is _not_ caught at load time; a ruleset change needs a
restart).

## 4. The flaky test, again (solved: see the postscript)

CI's `test-integration` failed once on the security commit and passed on the next two pushes
with no related change, and the full suite passed 3/3 times locally afterwards. CI logs aren't downloadable from this environment (the log storage host
returns 403), so I can't say which test failed. It's most likely the same end-to-end flake
recorded in the [integration journal](2026-10-28-integration.md). That's still a guess, and
STATUS lists it as a known issue. The next person should capture worker logs as a CI artifact
when that job fails, so the next occurrence explains itself.

## Things I'd tell a junior engineer

- **Read your example config as an attacker would.** People copy it into production.
- **Follow the data to the decision.** "Replay is harmless because we dedupe" was true for
  storage and false for scoring.
- **"Fail closed" isn't automatically safe.** For a rate limiter in front of everything, failing
  closed makes a cache problem an outage. Pick fail-open/closed per control and write down why.
- **Run your own README.** A claim you haven't executed is a hypothesis.

## Postscript (2026-10-29): the flaky test, solved

The flake came back, and this time on my machine, during the first run with coverage
instrumentation. With the output in hand:

```
AssertionError: expected null to be 100
 ❯ test/integration/end-to-end.test.ts:155
    expect(detail.summary.score).toBe(detail.score?.score);
```

_Observation:_ the score row said 100; the alert's `summary.score` was still `null`.
_Hypothesis:_ they're written by different transactions. _Check:_ `scoring` stores the score
together with the `alert.scored` event; `alerts.project-score` is a **separate subscriber** that
copies it onto the alert's queue columns one outbox hop later. The test polled until the score
existed, then read the projection once, a race it usually won. Coverage instrumentation slows
everything down a little, and that was enough to lose it.

So the product was right (eventual consistency, by design, ADR-0009) and the test assumed
read-your-writes across two consumers. _Fix:_ poll for the projection too. Two full runs with
coverage passed afterwards (535/535 both times).

**Lesson:** "flaky" is usually a race the test doesn't know it's in. Slowing the system down
(instrumentation, a loaded CI runner) is a cheap way to make a race show itself.
