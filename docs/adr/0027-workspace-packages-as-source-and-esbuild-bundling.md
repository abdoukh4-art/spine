# ADR-0027: Consume workspace packages as TypeScript source; bundle the API with esbuild

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, process

## Context and problem statement

`apps/api` and `apps/console` import `@spine/shared-schema`, `@spine/playbook-engine` and
`@spine/enrichers`. If those packages had to be compiled to `dist/` before every test, type
check or dev-server start, the inner loop would be slower and full of stale-build bugs
("I changed the schema but the API still sees the old one").

## Decision drivers

- Instant feedback: edit a package and the app sees it immediately (tests, dev server, type check).
- Production images run plain JavaScript with no TS loader at runtime.
- Few moving parts: no project references or per-package build orchestration.

## Considered options

1. **Packages export `./src/index.ts`; Vitest/tsx/Vite/tsc read the source; production API is bundled by esbuild (workspace code inlined, npm deps external)**
2. Each package builds to `dist/` with `tsc`, using TypeScript project references, and apps consume `dist/`
3. Custom export conditions (`"spine-source"` → src, `default` → dist)

## Decision outcome

**Chosen option 1.** `apps/api/build.mjs` bundles `main.ts`, `worker.ts` and the CLIs into
`dist/` as ESM. Third-party dependencies stay external, and the Docker image installs them
with `pnpm deploy --prod`. The console is bundled by Vite anyway.

### Consequences

- 👍 Zero build step during development. One `tsc --noEmit` per app type-checks packages too.
- 👍 Smaller runtime images: no TypeScript, no source.
- 👎 Packages can't be published to npm as-is (they're private and that's fine). Publishing
  would require option 2 or 3.
- 👎 The `packages/*/build` script is only a type check. Documented in each package README.

## What would make us revisit this

- We want to publish `@spine/playbook-engine` to npm → add a `tsc` build with an export condition (option 3).

## Further reading

- esbuild docs, _Bundling for node_; pnpm docs, _pnpm deploy_
