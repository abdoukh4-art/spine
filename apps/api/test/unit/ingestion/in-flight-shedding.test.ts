import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { BackpressureGuard } from '../../../src/modules/ingestion/application/backpressure.js';
import {
  registerIngestionRoutes,
  type IngestionRouteDeps,
} from '../../../src/modules/ingestion/adapters/http/routes.js';
import { InFlightLimit } from '../../../src/platform/http/in-flight-limit.js';
import { registerProblemHandlers } from '../../../src/platform/http/problem.js';

/**
 * ADR-0093: past INGEST_MAX_IN_FLIGHT concurrent requests, ingestion answers 503 at once instead
 * of queueing. The guard is stubbed to hold the first request "in flight" until we release it.
 */
async function harness(max: number) {
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => (releaseFirst = resolve));
  let calls = 0;
  const guard = {
    check: () => (calls++ === 0 ? held : Promise.resolve()),
  } as unknown as BackpressureGuard;
  let rejected = 0;
  const inFlight = new InFlightLimit(max);
  const deps = {
    guard,
    inFlight,
    metrics: { ingested: () => undefined, backpressureRejected: () => (rejected += 1) },
    webhookSources: {},
  } as unknown as IngestionRouteDeps;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemHandlers(app);
  await app.register((api) => registerIngestionRoutes(api, deps));
  return { app, inFlight, releaseFirst, rejected: () => rejected };
}

describe('ingestion in-flight limit', () => {
  it('sheds with 503 + Retry-After: 1 while the cap is taken, and frees the slot afterwards', async () => {
    const h = await harness(1);
    // First request parks in onRequest (the guard), holding the only slot.
    const first = h.app.inject({ method: 'POST', url: '/alerts', payload: {} });
    await expect.poll(() => h.inFlight.current).toBe(1);

    const second = await h.app.inject({ method: 'POST', url: '/alerts', payload: {} });
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('1');
    expect(second.json().type).toMatch(/overloaded$/);
    expect(h.rejected()).toBe(1);

    h.releaseFirst();
    await first; // finishes (with whatever the stubbed route does); the slot is released on close
    await expect.poll(() => h.inFlight.current).toBe(0);
    await h.app.close();
  });
});
