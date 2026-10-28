# ADR-0005: Zod schemas are the single source of truth for contracts; OpenAPI is generated

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, data

## Context and problem statement

The same shapes (Alert, PlaybookDefinition, Run, Problem) are needed in four places:
runtime validation at the API edge, TypeScript types in the API, TypeScript types in the
console, and the published OpenAPI document that integrators and contract tests rely on.
If these are written separately, they **will** drift.

## Decision drivers

- One definition → runtime validation + static types + documentation.
- Validation at every trust boundary (OWASP: *never trust input*).
- Contract tests must be able to check responses against the published spec.

## Considered options

1. **Zod 4 schemas in `packages/shared-schema` → types via `z.infer`, OpenAPI via `fastify-type-provider-zod` + `@fastify/swagger`**
2. OpenAPI YAML written by hand → generate TS types (openapi-typescript) + validate with Ajv
3. TypeBox (JSON-Schema-native) schemas
4. tRPC (no OpenAPI, typed RPC)

## Decision outcome

**Chosen option 1.**

- `packages/shared-schema/src/**` exports Zod schemas and inferred types.
- API routes declare `schema: { body, querystring, params, response }` with those schemas.
  Fastify validates requests and serializes responses through them, so **responses are also
  validated**, and internal fields can't leak by accident.
- `pnpm --filter @spine/api openapi:generate` writes `docs/architecture/openapi.json`.
  CI regenerates it and fails if the committed file differs (a contract-drift guard).
- Contract tests ([ADR-0021](0021-testing-strategy.md)) validate real responses against that document.

### Consequences

- 👍 A renamed field breaks the build in both the API and the console.
- 👍 Zod gives readable error messages, which we map to RFC 9457 problem details ([ADR-0024](0024-api-conventions.md)).
- 👎 Code-first OpenAPI is less "design-first": API design reviews happen on Zod code
  and the generated JSON. We accept this; the committed `openapi.json` diff makes changes reviewable.
- 👎 Zod is slower than Ajv-compiled validators. That's negligible at our scale; revisit if profiling shows otherwise.

## Pros and cons of the options

### Hand-written OpenAPI
- 👍 Design-first, language-neutral.
- 👎 Two artifacts (spec + validators) plus a code generation step. Spec and code can still drift without strict CI.

### TypeBox
- 👍 Native JSON Schema, very fast with Ajv.
- 👎 Less ergonomic for refinements and transforms (e.g. normalizing indicator values), and less familiar to learners.

### tRPC
- 👍 Excellent DX between TS client and server.
- 👎 No OpenAPI, and webhook senders and third-party integrators are not TypeScript.

## What would make us revisit this

- Validation shows up as more than 10 % of request CPU in profiles.
- We need non-TypeScript SDKs generated from a design-first spec.

## Further reading

- Zod docs: <https://zod.dev>
- OpenAPI 3.1 specification
