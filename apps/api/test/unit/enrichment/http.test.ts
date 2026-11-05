import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resilienceFromConfig } from '../../../src/modules/enrichment/adapters/providers.js';
import { createEnrichmentModule } from '../../../src/modules/enrichment/index.js';
import { testConfig } from '../../support/config.js';
import { as, buildTestServer, unitDeps } from '../support/module-deps.js';

let server: FastifyInstance;
const circuits: string[] = [];
beforeAll(async () => {
  const { module } = createEnrichmentModule(unitDeps(), {
    alertLookup: { get: () => Promise.resolve(null) },
    metrics: {
      recordLookup: () => undefined,
      recordCircuit: (provider, state) => circuits.push(`${provider}=${state}`),
    },
  });
  server = await buildTestServer([module]);
});
afterAll(async () => {
  await server.close();
});

describe('enrichment HTTP routes', () => {
  it('GET /enrichment/providers lists the three mock providers with closed breakers', async () => {
    const res = await server.inject({ url: '/api/v1/enrichment/providers', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: 'reputation',
        supports: ['ipv4', 'ipv6', 'domain', 'url', 'sha256', 'md5'],
        circuit: 'closed',
        inFlight: 0,
        queued: 0,
      },
      { name: 'geo', supports: ['ipv4', 'ipv6'], circuit: 'closed', inFlight: 0, queued: 0 },
      {
        name: 'asset-inventory',
        supports: ['hostname', 'ipv4', 'ipv6'],
        circuit: 'closed',
        inFlight: 0,
        queued: 0,
      },
    ]);
    // The gauge is initialised for every provider at startup.
    expect(circuits).toEqual(['reputation=closed', 'geo=closed', 'asset-inventory=closed']);
  });

  it('POST /alerts/:id/enrich is analyst-only, validates the id and 404s unknown alerts', async () => {
    const id = '00000000-0000-7000-8000-0000000000a1';
    const viewer = await server.inject({
      method: 'POST',
      url: `/api/v1/alerts/${id}/enrich`,
      headers: as('viewer'),
    });
    expect(viewer.statusCode).toBe(403);
    const badId = await server.inject({
      method: 'POST',
      url: '/api/v1/alerts/nope/enrich',
      headers: as('analyst'),
    });
    expect(badId.statusCode).toBe(400);
    const missing = await server.inject({
      method: 'POST',
      url: `/api/v1/alerts/${id}/enrich`,
      headers: as('analyst'),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().type).toBe('https://spine.dev/problems/not-found');
  });

  it('maps env vars onto the resilience config', () => {
    const r = resilienceFromConfig(
      testConfig({ ENRICHMENT_TIMEOUT_MS: '250', ENRICHMENT_MAX_ATTEMPTS: '5' }),
    );
    expect(r.timeoutMs).toBe(250);
    expect(r.retry.maxAttempts).toBe(5);
    expect(r.breaker.windowSize).toBe(20);
  });
});
