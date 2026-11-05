# ADR-0003: TypeScript (strict) on Node.js 22 LTS in a pnpm workspace monorepo

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, process

## Context and problem statement

We need one language for the API, the worker, the shared contracts and the console, so
that the alert schema is written **once** and type-checked everywhere. We also need a repo
layout that keeps reusable libraries (playbook engine, enrichers, schemas) separate from
the applications that use them.

## Decision drivers

- One source of truth for types across backend and frontend.
- Mature ecosystem for HTTP, queues, Postgres and testing.
- An LTS runtime with a long support window.
- Fast, disk-efficient installs and strict dependency isolation.

## Considered options

1. **TypeScript strict + Node 22 LTS + pnpm workspaces**
2. Go backend + TypeScript frontend
3. Python (FastAPI) backend + TypeScript frontend
4. TypeScript with npm workspaces / Yarn / Nx / Turborepo

## Decision outcome

**Chosen option 1.** Layout:

```
apps/api                    Fastify API + BullMQ worker (same codebase, two entrypoints)
apps/console                React 19 SPA
packages/shared-schema      Zod schemas = API/data contract (consumed by api + console)
packages/playbook-engine    Pure playbook DSL validation + durable executor (no I/O)
packages/enrichers          Enricher interface, resilience primitives, mock providers
```

TypeScript settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, and ESLint `no-explicit-any` set to error. Packages are consumed
**as TypeScript source** inside the workspace (`"exports"` pointing at `src/index.ts` for
dev, built `dist/` for production images). That avoids a "build packages before you can
test anything" dance.

pnpm is chosen over npm/Yarn because its strict `node_modules` layout makes **phantom
dependencies** (importing a package you never declared) fail immediately, and because its
content-addressed store makes CI installs fast. We do **not** add Nx or Turborepo:
`pnpm -r` with topological ordering is enough for five packages, and every extra tool is
something a learner must understand first.

### Consequences

- 👍 Shared types: if a schema field is renamed, the console stops compiling.
- 👍 One toolchain (ESLint, Prettier, Vitest) for everything.
- 👎 Node is single-threaded, so CPU-heavy work (none expected) would need worker threads.
- 👎 Source-level package consumption means each app's bundler or TS loader must handle TS
  from `packages/*`. Vite and tsx do this natively.

## Pros and cons of the options

### Go backend

- 👍 Excellent performance and static binaries.
- 👎 Two languages means duplicated schemas or code generation, and a steeper path for the target audience.

### Python backend

- 👍 Popular in security tooling.
- 👎 The same schema duplication problem. Type checking is optional and weaker.

### Nx / Turborepo

- 👍 Caching and affected-only builds.
- 👎 Overkill at five packages, and adds concepts to learn. Revisit if CI exceeds 10 minutes.

## What would make us revisit this

- CI time > 10 min → add Turborepo remote caching.
- A CPU-bound component (e.g. a heavy correlation engine) → consider a Go or Rust sidecar.
- Node 24 becomes Active LTS and dependencies support it → bump in a dedicated ADR.

## Further reading

- pnpm docs, _Motivation_ and _Symlinked node_modules structure_
- TypeScript handbook, _TSConfig reference: strict_
