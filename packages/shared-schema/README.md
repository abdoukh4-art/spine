# @spine/shared-schema

**The single source of truth for Spine's contracts** ([ADR-0005](../../docs/adr/0005-zod-contracts-and-openapi.md)).
Zod schemas provide runtime validation, `z.infer` provides TypeScript types, and the API
generates its OpenAPI document from the same objects. The API, the worker and the console all import it.

| File                                 | Contents                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common.ts`                          | IDs, timestamps, severities, roles, pagination, RFC 9457 problems                                                                                 |
| `alert.ts`                           | Canonical alert schema (ECS/OCSF-inspired), indicators, MITRE mapping, status machine ([ADR-0011](../../docs/adr/0011-canonical-alert-schema.md)) |
| `enrichment.ts`                      | Enrichment results, verdicts, provider payloads, circuit states                                                                                   |
| `scoring.ts`                         | Rulesets, score explanations, score → severity bands ([ADR-0015](../../docs/adr/0015-explainable-rule-based-scoring.md))                          |
| `condition.ts` / `condition-eval.ts` | The closed predicate language and its interpreter, shared by scoring and playbooks ([ADR-0013](../../docs/adr/0013-playbook-dsl.md))              |
| `playbook.ts`                        | Playbook DSL, run events, approvals, simulated actions                                                                                            |
| `auth.ts`                            | Users, login, audit entries                                                                                                                       |
| `metrics.ts`                         | MTTD/MTTR summary shapes ([ADR-0026](../../docs/adr/0026-mttd-mttr-definitions.md))                                                               |
| `events.ts`                          | Domain event catalog ([event catalog](../../docs/architecture/event-catalog.md))                                                                  |
| `api.ts`                             | HTTP request/response DTOs                                                                                                                        |

## Usage

```ts
import { CanonicalAlertInputSchema, evaluateCondition } from '@spine/shared-schema';

const alert = CanonicalAlertInputSchema.parse(untrustedJson); // throws ZodError if invalid
const isHot = evaluateCondition(
  { field: 'severity', op: 'in', value: ['high', 'critical'] },
  alert,
);
```

## Rules

- **Additive changes only** to published schemas. Breaking changes need a new API or event version.
- No I/O, no framework code. This package must stay importable from the browser.

## Scripts

`pnpm --filter @spine/shared-schema test` (61 tests including property-based laws for the
predicate interpreter), plus `typecheck`. `build` is a type check only ([ADR-0027](../../docs/adr/0027-workspace-packages-as-source-and-esbuild-bundling.md)).
