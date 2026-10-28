# 2026-10-28 — Ingestion and Alerts/Cases (Phase 1)

## Goal of the session

Build Spine's front door (normalizers, indicator rules, fingerprint, the ingest transaction,
idempotency, back-pressure, webhook HMAC, batch import) and the module that owns the alert
record (queue queries, triage, cases, score projection). One branch, `feat/ingestion-alerts`,
in parallel with five other workstreams.

## What I did, in order, and why

1. **Read before typing.** The brief, the vision, ADR-0002/0005/0009/0011/0012/0017/0024/0026,
   the contract docs and every platform file. Two things shaped the design immediately: the
   outbox publisher takes the _caller's_ transaction, and `alerts_open_fingerprint_uq` is a
   partial unique index. Together they dictate "one transaction, let the index arbitrate races".
2. **Pure domain first.** Normalizers, indicators, IP canonicalization, fingerprint, HMAC check,
   idempotency helpers. All of it is testable in milliseconds, so I wrote it before any SQL.
3. **Alerts module next**, because ingestion persists through its public API. I extended
   `AlertsPublicApi` additively with `findOpenByFingerprint`, `recordDuplicate` and `create`,
   all taking the caller's transaction executor.
4. **Ingestion application + adapters**, then composition wiring, then unit tests, then
   integration tests, then documentation.

## Bugs and how I found them (hypothesis → experiment → result)

### 1. The race test that couldn't fail

The brief asked for "20 concurrent ingests → 1 open alert, duplicate_count 19". I wrote it,
and it passed on the first run. A test that passes first time deserves suspicion.

- _Hypothesis:_ the test passes because the retry-after-unique-violation logic works.
- _Experiment:_ set `maxAttempts` to 1 (no retries) and run it again.
- _Result:_ **still green.** So the retry path was never exercised. (The idempotency
  concurrency test did fail without retries, so the retry code itself was reachable.)
- _Second hypothesis:_ the requests are not actually concurrent at the database.
- _Experiment:_ log a timestamp when each transaction starts and when its SELECT returns.
- _Result:_ the first transaction started at t=2246 ms and saw "no open alert" at 2258 ms;
  the next one only started at 2291 ms, after the first had committed. The pool starts with
  one connection and opening the others takes tens of milliseconds, so the first request wins
  by a mile every time. All 19 others took the `FOR UPDATE` duplicate path.
- _Fix:_ the test now wraps the real alerts API with a **barrier**: the first 4 transactions
  that see "no open alert" wait for each other, then all INSERT. Now 3 of them really hit
  `23505`, retry, and become duplicates. With retries disabled the test fails (409s); with
  them it passes, and it asserts `lostRaces >= 1` so it can never go vacuous again.
- _Lesson:_ **a concurrency test must prove the interleaving happened**, not just check the end
  state. Mutate the code under test (here: disable the retry) and make sure the test notices.

### 2. The property test that missed a real idempotence bug

`refang` must loop until nothing changes: `[(.)]` → `[.]` → `.`. I wrote the loop first, then
asked whether the idempotence property would catch a single-pass version.

- _Experiment:_ make `refang` single-pass, run `normalize(normalize(x)) = normalize(x)` with 500 runs.
- _Result:_ green. The generator never produced a defanged token nested inside another one in a
  position that survives validation (a URL path).
- _Fix 1:_ add a URL-with-random-bracket-characters generator. Still green: random characters
  almost never spell `[(.)]`.
- _Fix 2:_ generate URL paths from _tokens_ (`[(.)]`, `([.])`, `[.]`, `(.)`, `[`, `)`, `x`).
  fast-check now fails the single-pass version and shrinks it to `http://a.aa/[(.)]`.
- Bonus: my doc comment's own example (`[[.].]` → `.`) was wrong. A plain example test showed
  one pass gives `[..]` and that's already a fixpoint. The comment now uses `[(.)]`.
- _Lesson:_ property tests are only as strong as their generators. **Check a property by
  breaking the code on purpose.**

### 3. The NULL trap in score pagination

Sorting by `score DESC NULLS LAST` with a cursor is the classic place to get keyset paging
wrong: `(score, id) < (k, id)` is _unknown_ when `score` is NULL, so unscored alerts vanish.
I wrote the three-branch predicate (ADR-0037), then mutated it back to the tuple comparison:
both score-walk integration tests fail. Good: the tests discriminate.

### 4. A 64-bit number that JavaScript rounds

Suricata's `flow_id` is a 64-bit integer. `JSON.parse('{"f":1844674407370955161}').f` is
`1844674407370955300` (anything above 2^53 loses its low digits). Two flows could therefore get
the same id, and the dedup fingerprint is built from it. The normalizer reads the digits from
the raw text when it has it (webhooks and batch lines always do), and the webhook route keeps
the raw body anyway for the HMAC. A fixture uses exactly that number, and the test asserts every digit.

### 5. Smaller ones

- _Category order matters._ "ET MALWARE Cobalt Strike Beacon" classified as
  `command_and_control`, not `malware`: the C2 rule matches "beacon" first. I decided that's
  correct and pinned it in the test with a comment, rather than reordering rules to fit my guess.
- _Strict lint finds real things._ `JSON.stringify` is typed as returning `string`, but returns
  `undefined` for `undefined` or functions; I had to make that explicit. Kysely wanted `Date`,
  not ISO strings, for timestamp comparisons in `where`.
- _Prettier and shared tables._ Editing one cell of a shared Markdown table re-pads the whole
  table, which guarantees merge conflicts with the other five branches. I kept new ADR titles
  short enough not to widen the index columns, and put the event-catalog change in a note
  below the table instead of in it.

## Decisions I'd flag to a reviewer

- **Suricata identity is `flow_id:signature_id`**, not `flow_id` as the brief said: two signatures
  on one flow would otherwise merge, hiding the more serious one. Cost: beacons don't collapse
  for Suricata (ADR-0031 lists the revisit trigger).
- **`generic` normalizer removed** from the config enum (ADR-0030): a heuristic mapper that
  guesses fields silently produces wrong data.
- **`resolvedAt` = first close, kept forever** (ADR-0036). MTTR must filter on status too.
- **`BatchResult.skipped`** added to the shared schema (additive) so Suricata telemetry in an
  EVE file isn't reported as 10 000 errors.
- **Raw cap counts UTF-8 bytes**, not `.length` as the brief's pseudo-code did: the constant is
  named `RAW_PAYLOAD_MAX_BYTES` and non-ASCII text is 2–4 bytes per character.

## What I'd tell a junior engineer from this session

- When the spec says "catch the unique violation and retry", ask _what state the transaction is
  in after the error_. In Postgres it's aborted: you can't continue in it, you must start over.
- A test that has never failed has not yet proven anything. Make it fail once, on purpose.
- Keep I/O out of the parts with the hard rules (normalization, fingerprints, transitions).
  That's where 90 % of the bugs would be, and pure code is where tests are cheap.
