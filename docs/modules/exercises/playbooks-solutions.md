# Playbooks module: exercise solutions

Try the exercises in [playbooks.md](../playbooks.md) first. These are model answers, not
the only correct ones.

## 1. Find the line

- `packages/playbook-engine/src/executor.ts`, `executeStep`: `await out.append(started)`
  runs **before** `runHandler`. After the crash the log ends with `step.started` for that
  step.
- `packages/playbook-engine/src/decide.ts`, `decideStep`, `case 'running'`: returns
  `ExecuteStep { attempt: s.attempts, resume: true }`. Same attempt → same key from
  `idempotencyKey(runId, stepId, attempt)`, and `resume: true` means no second `step.started`.
- `apps/api/src/modules/playbooks/adapters/simulated/recorder.ts`, `perform`: the first
  thing it does is `findByKey`, returning the stored response. So the firewall "acts" once,
  and the step's output is the original `blockId`.
- The step completes because the resumed `advance` appends `step.succeeded` after the
  replayed handler call. Proven by `playbooks.test.ts` › "crash/resume: …".

## 2. A new property

```ts
it('no step succeeds twice, and every success follows a start', async () => {
  await fc.assert(
    fc.asyncProperty(runArb, async ({ spec, dupCount, rejects }) => {
      const def = parsed(spec);
      const { log } = await reference(def, dupCount, decisionsFor(def, rejects));
      const started = new Set<string>();
      const succeeded = new Set<string>();
      for (const e of log) {
        if (e.type === 'step.started') started.add(e.stepId!);
        if (e.type === 'step.succeeded') {
          expect(started.has(e.stepId!)).toBe(true);
          expect(succeeded.has(e.stepId!)).toBe(false);
          succeeded.add(e.stepId!);
        }
      }
    }),
  );
});
```

Add the crash variant too: run it on the logs produced by the crash-resume property.

## 3. Deterministic jitter

Jitter exists so that many runs failing at the same moment don't retry at the same moment.
It doesn't need to be _random_, only _spread_. Derive it from something stable:

```ts
const spread = parseInt(sha256(idempotencyKey).slice(0, 8), 16) / 0xffffffff; // 0..1
const delayMs = Math.round(base * 2 ** (attempt - 1) * (0.5 + spread / 2)); // "equal jitter"
```

`decide` stays pure (same key → same delay), replays stay identical, and different runs
spread out. `crypto` is I/O-free, but if you want the engine dependency-free, pass a
`hash` function through `DecideContext`.

## 4. Hyphens in paths

The template regex in `renderTemplate` and `FieldPathSchema` both use
`[A-Za-z_][A-Za-z0-9_]*` per segment. Allowing `-` inside segments
(`[A-Za-z_][A-Za-z0-9_-]*`) fixes it. Consequences to check:

- It's a `@spine/shared-schema` change, so scoring rules accept the same paths. That's
  harmless, but add tests to both.
- `getPath` already rejects `__proto__`/`constructor`, so there's no new injection surface.
- The alternative is to keep paths strict and forbid hyphens in step IDs. That's a
  breaking change for existing playbooks, so it's worse.

## 5. Cancel and roll back

- New event `run.cancel_requested {compensate: boolean, by}` (never repurpose `run.cancelled`).
- Reducer: on it, set `state.cancelRequested = {compensate}`; if `compensate`, also set
  `failure = {stepId: currentStepId, error: 'cancelled'}`, which the decider already treats
  as "start compensation".
- Decider: if `cancelRequested && !compensate` → `Finish{cancelled}`; with compensate,
  `decideRecovery` runs and finishes `compensated`/`failed`. Make `Finish` accept `cancelled`.
- The API appends `run.cancel_requested` (optimistic, like `cancel` today) and enqueues the
  run so the executor does the undo work. The API process never calls integrations.
- Tests: engine unit test (cancel mid-run → compensations in reverse), a property (cancel at
  any point → reverse order holds), and an integration test with block → cancel → unblock row.
