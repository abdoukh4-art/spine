# @spine/api

Spine's backend: a **hexagonal modular monolith** ([ADR-0002](../../docs/adr/0002-hexagonal-modular-monolith.md))
with two entrypoints from one codebase:

- `src/main.ts`: HTTP API (Fastify) on `HTTP_PORT`.
- `src/worker.ts`: outbox relay, event subscribers and background tasks (BullMQ).

## Layout

```
src/
  composition.ts          composition root: wires modules' public APIs together
  platform/               shared kernel (no business rules)
    config.ts             env validation (twelve-factor)
    logger.ts             pino JSON logs with secret redaction
    errors.ts             AppError hierarchy → RFC 9457 problems
    runtime.ts            Clock / IdGenerator ports (+ test doubles)
    db/                   Kysely, row types, forward-only SQL migrator
    events/               EventPublisher port, transactional outbox, relay, in-memory doubles
    queue/                BullMQ delivery queue and event worker
    http/                 server (security, OpenAPI, health), access control, problems, pagination
    telemetry/            OpenTelemetry facade
    lifecycle.ts          graceful shutdown
  modules/<context>/      domain/ · application/ · adapters/ · public-api.ts · index.ts
migrations/               NNNN_<module>_<desc>.sql (number ranges reserved per module)
test/unit · test/integration · test/support
```

## Commands

```bash
pnpm --filter @spine/api dev              # API with reload (needs .env + Postgres + Redis)
pnpm --filter @spine/api dev:worker       # worker with reload
pnpm --filter @spine/api test             # unit tests
pnpm --filter @spine/api test:integration # Testcontainers, or TEST_DATABASE_URL/TEST_REDIS_URL
pnpm --filter @spine/api migrate          # apply migrations and exit
pnpm --filter @spine/api build            # esbuild bundle → dist/ (ADR-0027)
pnpm openapi:generate                     # refresh docs/architecture/openapi.json
```

## Adding a route

Every route **must** declare `config.access`, or the server refuses to start:

```ts
app.get(
  '/alerts',
  { config: { access: { role: 'viewer' } }, schema: { querystring: AlertListQuerySchema } },
  handler,
);
```
