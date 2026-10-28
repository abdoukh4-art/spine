# ADR-0004: Fastify as the HTTP framework

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture

## Context and problem statement

The API needs routing, schema-based validation, serialization, a plugin system for
cross-cutting concerns (auth, rate limiting, security headers) and good performance under
bursty ingestion load.

## Decision drivers

- First-class schema validation and OpenAPI generation.
- Encapsulated plugins (useful for keeping module routes isolated).
- Throughput and low overhead (ingestion bursts).
- Built-in structured logging (pino) with request IDs.

## Considered options

1. **Fastify 5**
2. Express 5
3. NestJS
4. Hono

## Decision outcome

**Chosen option: Fastify 5**, with `fastify-type-provider-zod` so that Zod schemas from
`@spine/shared-schema` drive request validation, response serialization **and** the
OpenAPI document ([ADR-0005](0005-zod-contracts-and-openapi.md)).

Fastify's encapsulation model maps neatly onto our modules: each module registers its
routes as a plugin under its own prefix, and decorators added inside one plugin don't
leak to siblings.

Fastify is confined to `adapters/http` folders and `platform/http`. It **never** appears
in `domain/` or `application/` ([ADR-0002](0002-hexagonal-modular-monolith.md)).

### Consequences

- 👍 Request IDs, pino logging, schema validation and graceful `close()` come out of the box.
- 👍 Its benchmarks are among the fastest Node frameworks, which leaves headroom for ingestion.
- 👎 A smaller ecosystem than Express. Some middleware needs Fastify-specific versions (`@fastify/*`).

## Pros and cons of the options

### Express 5
- 👍 Ubiquitous, and everyone knows it.
- 👎 No built-in schema validation or serialization. Async error handling only arrived in v5. Slower.

### NestJS
- 👍 Batteries included: DI, modules.
- 👎 Decorator-heavy and framework-centric. It pushes framework concepts into business
  code, which works against hexagonal purity. Lots of magic for learners.

### Hono
- 👍 Tiny, fast, runs at the edge.
- 👎 A younger ecosystem for OpenAPI, rate limiting and cookie handling on Node, and less production mileage.

## What would make us revisit this

- If `fastify-type-provider-zod` becomes unmaintained or lags Zod releases by more than
  6 months, switch to `@asteasolutions/zod-to-openapi` with manual route schemas.

## Further reading

- Fastify docs: *Encapsulation*, *Lifecycle*, *Validation and Serialization*
