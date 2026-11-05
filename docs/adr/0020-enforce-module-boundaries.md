# ADR-0020: Enforce architectural boundaries with dependency-cruiser in CI

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, process

## Context and problem statement

Architecture rules that are only written down erode within weeks: one "quick" import of
`fastify` into a domain file, one reach into another module's repository. We need the
rules from [ADR-0002](0002-hexagonal-modular-monolith.md) to be **executable**.

## Decision drivers

- Fail CI on a violation, with a clear message explaining _which rule_ and _why_.
- Express path-based rules (folders) and package-based rules (forbidden npm packages in `domain/`).
- Visualize the dependency graph for learners.

## Considered options

1. **dependency-cruiser** with a rules file
2. `eslint-plugin-boundaries`
3. Nx module boundary tags
4. TypeScript project references only

## Decision outcome

**Chosen option: dependency-cruiser** (`.dependency-cruiser.cjs`). Rules:

| Rule                      | Meaning                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain-is-pure`          | `modules/*/domain/**` and `packages/playbook-engine/src/**` may not import `fastify`, `kysely`, `pg`, `bullmq`, `ioredis`, `@opentelemetry/*`, `pino`, `node:fs`, `node:net`, `node:http` |
| `domain-no-outward`       | `domain/` may not import `application/` or `adapters/`                                                                                                                                    |
| `application-no-adapters` | `application/` may not import `adapters/`                                                                                                                                                 |
| `module-public-api-only`  | `modules/A/**` may import `modules/B/**` only via `modules/B/public-api.ts`                                                                                                               |
| `platform-no-modules`     | `platform/**` may not import `modules/**` (the shared kernel knows no business)                                                                                                           |
| `packages-no-apps`        | `packages/**` may not import `apps/**`                                                                                                                                                    |
| `no-circular`             | no import cycles                                                                                                                                                                          |
| `no-orphans` (warn)       | unused files                                                                                                                                                                              |

`pnpm lint:arch` runs it, and it is part of the required CI checks. `pnpm graph:arch`
emits an SVG/Mermaid graph for docs.

### Consequences

- 👍 Violations fail with the rule's `comment` text (the "why"), so the error teaches.
- 👎 Another config file to maintain. Rules must be updated when folders move.

## Pros and cons of the options

### eslint-plugin-boundaries

- 👍 Runs inside the editor.
- 👎 Element-type configuration is more verbose, and cycle detection across packages is weaker.

### Nx tags

- 👎 Needs Nx (rejected in [ADR-0003](0003-typescript-node-pnpm-monorepo.md)).

### TS project references

- 👍 Compile-level boundaries between packages.
- 👎 Can't express folder-level rules _inside_ apps/api.

## What would make us revisit this

- The editor-feedback gap annoys contributors → add eslint-plugin-boundaries alongside for in-editor hints.

## Further reading

- dependency-cruiser docs, _Rules reference_
- Robert C. Martin, _Clean Architecture_, "The Dependency Rule"
