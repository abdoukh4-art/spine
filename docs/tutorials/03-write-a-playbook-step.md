# Tutorial 03: Write a playbook step type

**Goal:** add an `isolate_host` step: ask the (simulated) EDR to cut a compromised host off the
network, and undo it automatically if a later step fails. Then use it in a playbook.

**You will learn:** how a DSL change flows through the contract
([ADR-0005](../adr/0005-zod-contracts-and-openapi.md)), ports and simulated adapters
([ADR-0018](../adr/0018-simulated-response-adapters.md)), idempotency keys and **compensation**
(the saga pattern, [ADR-0010](../adr/0010-event-sourcing-for-playbook-runs-only.md)), and how
TypeScript's exhaustiveness checks find every place you forgot.
**Time:** ~60–90 minutes. **Prerequisites:** the [playbooks module guide](../modules/playbooks.md)
and the [engine README](../../packages/playbook-engine/README.md).

> The schema, port, adapter and handler changes below were rehearsed against the real repository
> while writing this tutorial; the type-check results quoted in step 5 are the real ones.

## The map: where a step type lives

| Layer             | File                                                                | What you add                                                                                         |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Contract (DSL)    | `packages/shared-schema/src/playbook.ts`                            | `IsolateHostStepSchema`, the union member, `STEP_TYPES`, two simulated action kinds                  |
| Engine            | `packages/playbook-engine`                                          | **nothing.** The engine is generic over step types (it only knows _branch_ and _approval_ specially) |
| Port              | `apps/api/src/modules/playbooks/application/ports.ts`               | `EdrPort` + `ResponseActions.edr`                                                                    |
| Simulated adapter | `apps/api/src/modules/playbooks/adapters/simulated/integrations.ts` | `edr.isolate` / `edr.release`                                                                        |
| Handler           | `apps/api/src/modules/playbooks/application/step-handlers.ts`       | `isolate_host` execute + compensate                                                                  |
| Console           | `apps/console/src/...`                                              | labels for the new step and action kinds (the compiler tells you where)                              |

That the engine needs **no change** is the payoff of keeping it pure and generic. Adding
capabilities happens at the edges.

## 1. Extend the DSL (the contract)

In `packages/shared-schema/src/playbook.ts`, next to `BlockIndicatorStepSchema`:

```ts
export const IsolateHostStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('isolate_host'),
    with: z
      .object({
        /** Why the host is isolated; shown to the endpoint user. Template, rendered as text. */
        reason: TemplateString,
        durationMinutes: z.number().int().min(5).max(1440).default(240),
      })
      .strict(),
    compensate: z
      .object({ type: z.literal('release_host') })
      .strict()
      .optional(),
    next: StepIdSchema.optional(),
  })
  .strict();
```

Then add `IsolateHostStepSchema` to the `StepSchema` discriminated union, `'isolate_host'` to
`STEP_TYPES`, and `'edr.isolate'`, `'edr.release'` to `SIMULATED_ACTION_KINDS`.

Why each choice:

- **`.strict()`** rejects unknown keys. A typo like `durationMinute: 30` is a load-time error, not a silently ignored parameter.
- **Bounds** (`5..1440` minutes): a playbook author can't isolate a server for a year by accident.
- **`reason` is a template, not an expression.** `{{alert.title}}` is a path lookup, never code (ADR-0013).

## 2. Declare the port

In `ports.ts`, describe _what the application needs_, not how an EDR works:

```ts
/** Endpoint detection and response (EDR) console. */
export interface EdrPort {
  isolate(
    request: { hostname: string; reason: string; durationMinutes: number; alertId: string },
    options: ActionOptions,
  ): Promise<{ isolationId: string; hostname: string; until: string }>;
  release(
    request: { isolationId: string; hostname: string },
    options: ActionOptions,
  ): Promise<{ isolationId: string; released: boolean }>;
}
```

…and add `edr: EdrPort;` to `ResponseActions`. `ActionOptions` carries the **idempotency key**
(`runId:stepId:attempt`), the dry-run flag and the abort signal: everything a well-behaved real API client needs.

## 3. Implement the simulated adapter

In `adapters/simulated/integrations.ts`:

```ts
const edr: EdrPort = {
  async isolate(request, options) {
    const until = new Date(clock.now().getTime() + request.durationMinutes * 60_000).toISOString();
    const response = await recorder.perform('edr.isolate', options, request, () => ({
      isolationId: stableId('ISO', options.idempotencyKey),
      hostname: request.hostname,
      until,
    }));
    return {
      isolationId: String(response.isolationId),
      hostname: String(response.hostname),
      until: String(response.until),
    };
  },
  async release(request, options) {
    const response = await recorder.perform('edr.release', options, request, () => ({
      isolationId: request.isolationId,
      released: true,
    }));
    return { isolationId: String(response.isolationId), released: response.released === true };
  },
};
```

and return it: `return { firewall, edr, ticketing, chat, statusPreview };`.

`recorder.perform` is where the safety lives. It writes the effect to `simulated_actions`
**keyed by the idempotency key**: calling it twice with the same key returns the first result
and writes nothing new. That's what makes the crash-resume guarantee in
[sequences.md §2](../architecture/sequences.md) hold for your step too: if the worker dies
right after isolating, the retry gets the same `isolationId` instead of isolating twice.

## 4. Write the handler (and its compensation)

In `application/step-handlers.ts`, register it next to `block_indicator`:

```ts
isolate_host: {
  ...typed('isolate_host', (step, ctx) => isolateHost(deps, step, ctx)),
  compensate: (step, ctx, original) => releaseHost(deps, step, ctx, original),
},
```

```ts
async function isolateHost(
  deps: StepHandlerDeps,
  step: StepOf<'isolate_host'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const alert = requireAlert(ctx);
  const hostname = alert.host?.hostname;
  // Nothing to isolate is not a failure: the alert simply has no host (e.g. a phishing email).
  if (!hostname) return { isolated: false, reason: 'alert has no host' };
  const reason = renderTemplate(step.with.reason, { alert, run: { id: ctx.runId } });
  const result = await deps.actions.edr.isolate(
    { hostname, reason, durationMinutes: step.with.durationMinutes, alertId: alert.id },
    actionOptions(step.id, ctx),
  );
  return { ...result, isolated: true, dryRun: ctx.dryRun };
}

async function releaseHost(
  deps: StepHandlerDeps,
  step: Step,
  ctx: StepContext,
  original: unknown,
): Promise<Record<string, unknown>> {
  const isolationId = readString(original, 'isolationId');
  const hostname = readString(original, 'hostname');
  if (isolationId === undefined || hostname === undefined) {
    return { released: false, reason: 'nothing was isolated' };
  }
  return deps.actions.edr.release({ isolationId, hostname }, actionOptions(step.id, ctx));
}
```

Two ideas to absorb:

- **The step's output is its memory.** `compensate` receives `original`, the output recorded in the
  `step.succeeded` event. That's how `releaseHost` knows _which_ isolation to undo, even after a
  restart: the event log, not process memory, is the source of truth (event sourcing, ADR-0010).
- **"Nothing to do" is success, not failure.** Failing the step would trigger compensation of
  everything before it, which is an over-reaction to an alert that has no host.

## 5. Let the compiler find the rest

Run `pnpm -r typecheck`. The API compiles. The **console** doesn't, and in the rehearsal it reported exactly:

```
apps/console  src/fake/fixtures.ts(380,4): error TS2366: Function lacks ending return statement …
apps/console  src/features/playbooks/PlaybookFlow.tsx(31,41): error TS2366: Function lacks ending return statement …
apps/console  src/features/simulated/SimulatedActionsPage.tsx(17,7): error TS2739: … missing the following properties … "edr.isolate", "edr.release"
```

These are **exhaustiveness checks**: a `switch` over every step type with no `default`, and a
`Record<SimulatedActionKind, string>` of labels. Adding a union member breaks the build exactly
where the UI must learn about it. Add a case that describes the step ("Isolate host for N
minutes") and the two labels ("EDR: isolate host", "EDR: release host"). This is the best
argument for `strict` TypeScript plus shared schemas ([ADR-0003](../adr/0003-typescript-node-pnpm-monorepo.md)):
the compiler is your checklist.

## 6. Test it

Following the playbooks tests (`apps/api/test/integration/playbooks.test.ts` shows the harness), write:

1. **Happy path:** a playbook `isolate → notify` runs, and `simulated_actions` has one `edr.isolate` row.
2. **Compensation:** `isolate → create_ticket` with the ticketing adapter forced to fail
   (the harness's `FaultControls`). The run ends `compensated`, and `simulated_actions` shows
   `edr.isolate` **then** `edr.release`.
3. **Crash-resume:** append `step.started` for `isolate` without a completion, call `advance`, and
   assert exactly **one** `edr.isolate` row (idempotency key reuse).
4. **Dry run:** the row has `dryRun: true`, and nothing else is written.

## 7. Use it

```yaml
- id: isolate
  name: Cut the host off the network
  type: isolate_host
  with:
    reason: 'Spine run {{run.id}}: {{alert.title}}'
    durationMinutes: 120
  compensate: { type: release_host }
  retry: { maxAttempts: 3, backoffMs: 1000 }
  next: ticket
```

Publish it as a new version (`POST /api/v1/playbooks`, admin) or add it to
`apps/api/config/playbooks/malware-containment.yaml` with a **bumped `version`**: published
versions are immutable, and runs pin the version they started with.

## Check your understanding

1. Why does the idempotency key include the **attempt** number (`runId:stepId:attempt`), and
   when does a crash-resume reuse the _same_ attempt's key? ([ADR-0050](../adr/0050-playbook-engine-reduce-decide-act.md))
2. Compensation runs in **reverse order of completion**. Construct a two-step example where
   forward order would leave the system in a worse state.
3. Should `isolate_host` require an approval gate before it in every playbook? Where would you
   enforce that: in the DSL validator, in a lint rule for playbooks, or in a review checklist? Argue each.
