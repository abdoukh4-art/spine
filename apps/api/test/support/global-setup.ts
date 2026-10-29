import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Integration-test infrastructure (ADR-0021).
 * - If TEST_DATABASE_URL / TEST_REDIS_URL are set, use those servers (CI service
 *   containers, or a developer's local instances).
 * - Otherwise start disposable Postgres 16 and Redis 7 containers with Testcontainers.
 * Each test file then isolates itself in its own Postgres schema (see test/support/db.ts).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;
  if (!databaseUrl) {
    postgres = await new PostgreSqlContainer(
      process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine',
    ).start();
    databaseUrl = postgres.getConnectionUri();
  }
  if (!redisUrl) {
    redis = await new RedisContainer(process.env.TEST_REDIS_IMAGE ?? 'redis:7-alpine').start();
    redisUrl = redis.getConnectionUrl();
  }
  // Extensions are database-wide; install them once in `public` so every test schema sees them.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public');
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await client.end();
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);
}

export async function teardown(): Promise<void> {
  await postgres?.stop();
  await redis?.stop();
}
