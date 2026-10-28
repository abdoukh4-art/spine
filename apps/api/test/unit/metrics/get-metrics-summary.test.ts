import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsModule } from '../../../src/modules/metrics/index.js';
import {
  GetMetricsSummary,
  resolveWindow,
  type MetricsReadModel,
} from '../../../src/modules/metrics/application/get-metrics-summary.js';
import { ValidationError } from '../../../src/platform/errors.js';
import { RecordingEventPublisher } from '../../../src/platform/events/in-memory.js';
import { buildHttpServer } from '../../../src/platform/http/server.js';
import { createLogger } from '../../../src/platform/logger.js';
import type { PlatformDeps } from '../../../src/platform/module.js';
import { ManualClock, SequentialIdGenerator } from '../../../src/platform/runtime.js';
import { testConfig } from '../../support/config.js';

const clock = new ManualClock('2026-10-28T12:00:00Z');
const readModel: MetricsReadModel = {
  alertsReceivedBetween: () =>
    Promise.resolve([
      {
        occurredAt: new Date('2026-10-28T10:00:00Z'),
        receivedAt: new Date('2026-10-28T10:02:00Z'),
        resolvedAt: null,
        severity: 'high',
      },
    ]),
  runsBetween: () => Promise.resolve([]),
};

describe('resolveWindow', () => {
  it('defaults to the last 7 days ending now', () => {
    expect(resolveWindow({}, clock)).toEqual({
      from: new Date('2026-10-21T12:00:00Z'),
      to: new Date('2026-10-28T12:00:00Z'),
    });
  });
  it('rejects inverted and oversized windows', () => {
    expect(() =>
      resolveWindow({ from: '2026-10-28T00:00:00Z', to: '2026-10-27T00:00:00Z' }, clock),
    ).toThrow(ValidationError);
    expect(() =>
      resolveWindow({ from: '2026-01-01T00:00:00Z', to: '2026-10-27T00:00:00Z' }, clock),
    ).toThrow(/90 days/);
  });
});

describe('GetMetricsSummary', () => {
  it('computes the summary from the read model', async () => {
    const summary = await new GetMetricsSummary(readModel, clock).execute({});
    expect(summary.mttd).toMatchObject({ count: 1, meanSeconds: 120 });
    expect(summary.mttr).toMatchObject({ count: 0, openCount: 1, meanSeconds: null });
  });
});

describe('GET /api/v1/metrics/summary', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('requires a viewer and returns a schema-valid summary', async () => {
    const config = testConfig();
    const deps = {
      config,
      logger: createLogger(config),
      clock,
      ids: new SequentialIdGenerator(),
      events: new RecordingEventPublisher(),
      redis: null,
      db: undefined as never,
    } satisfies PlatformDeps;
    const { module } = createMetricsModule(deps, readModel);
    app = await buildHttpServer({
      config,
      modules: [module],
      redis: null,
      logger: false,
      readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
      authenticator: {
        authenticate: () =>
          Promise.resolve({
            kind: 'user',
            id: '00000000-0000-7000-8000-000000000001',
            role: 'viewer',
            email: 'v@spine.test',
          }),
      },
    });
    expect((await app.inject('/api/v1/metrics/summary')).statusCode).toBe(401);
    const res = await app.inject({
      url: '/api/v1/metrics/summary',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alertVolume.bySeverity.high).toBe(1);
    const bad = await app.inject({
      url: '/api/v1/metrics/summary?from=nope',
      headers: { authorization: 'Bearer x' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
