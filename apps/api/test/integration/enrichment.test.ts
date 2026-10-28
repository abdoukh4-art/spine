import {
  createGeoEnricher,
  createReputationEnricher,
  DEFAULT_RESILIENCE,
  ResilientEnricher,
} from '@spine/enrichers';
import type { Alert } from '@spine/shared-schema';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnrichmentModule } from '../../src/modules/enrichment/index.js';
import { as, buildTestServer } from '../unit/support/module-deps.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import {
  ingestedEvent,
  integrationDeps,
  knownBadAlert,
  outboxEvents,
} from './enrichment-scoring.support.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

function moduleWith(alerts: Alert[] = [], overrides: Record<string, string> = {}) {
  return createEnrichmentModule(integrationDeps(t.db, overrides), {
    alertLookup: { get: (id) => Promise.resolve(alerts.find((a) => a.id === id) ?? null) },
  });
}
const subscriber = (m: ReturnType<typeof moduleWith>) => {
  const handler = m.module.subscribers?.()[0];
  if (handler?.eventType !== 'alert.ingested') throw new Error('subscriber missing');
  return handler as unknown as { handle(e: ReturnType<typeof ingestedEvent>): Promise<void> };
};

describe('enrichment.on-alert-ingested (integration)', () => {
  it('enriches, stores one row per lookup and publishes alert.enriched in the same transaction', async () => {
    const alert = knownBadAlert();
    const m = moduleWith();
    await subscriber(m).handle(ingestedEvent(alert));

    const stored = await m.api.getForAlert(alert.id);
    expect(
      stored.map((r) => `${r.provider}:${r.indicator.value}:${r.status}:${r.verdict ?? '-'}`),
    ).toEqual([
      // ordered by indicator type, value, then provider
      'reputation:update-check.test:ok:malicious',
      'asset-inventory:dc01.corp.example:ok:-',
      'asset-inventory:10.10.0.10:ok:-',
      'geo:203.0.113.66:ok:-',
      'reputation:203.0.113.66:ok:malicious',
    ]);
    const events = await outboxEvents(t.db, 'alert.enriched', alert.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.enrichments).toEqual(stored);
    expect(events[0]?.payload.alert.id).toBe(alert.id);
  });

  it('is idempotent: a redelivered event writes and publishes nothing more (ADR-0040)', async () => {
    const alert = knownBadAlert();
    const m = moduleWith();
    const event = ingestedEvent(alert);
    // Three concurrent deliveries of a fresh event all pass the pre-check and all call the
    // providers; the inbox primary key lets exactly one transaction commit its writes.
    await Promise.all([1, 2, 3].map(() => subscriber(m).handle(event)));
    // A later redelivery is stopped by the pre-check.
    await subscriber(m).handle(event);
    expect(await outboxEvents(t.db, 'alert.enriched', alert.id)).toHaveLength(1);
    const inbox = await t.db
      .selectFrom('enrichment_processed_events')
      .selectAll()
      .where('alert_id', '=', alert.id)
      .execute();
    expect(inbox.map((r) => r.event_id)).toEqual([event.eventId]);
  });

  it('records failures as results instead of throwing, and never replaces a success with a failure (ADR-0041)', async () => {
    const alert = knownBadAlert({
      host: {},
      indicators: [{ type: 'ipv4', value: '203.0.113.66' }],
    });
    await subscriber(moduleWith()).handle(ingestedEvent(alert));

    // Same alert, re-enriched while every provider is down.
    const broken = moduleWith([alert], {
      ENRICHMENT_FAILURE_RATE: '1',
      ENRICHMENT_MAX_ATTEMPTS: '1',
    });
    const merged = await broken.api.enrichAlert(alert);
    expect(merged.map((r) => r.status)).toEqual(['ok', 'ok']);

    // A brand-new indicator whose only lookup fails is stored as a data gap.
    const withNew = {
      ...alert,
      indicators: [...alert.indicators, { type: 'ipv4' as const, value: '198.51.100.23' }],
    };
    const after = await broken.api.enrichAlert(withNew);
    expect(after.filter((r) => r.indicator.value === '198.51.100.23').map((r) => r.status)).toEqual(
      ['error', 'error'],
    );
    expect(await outboxEvents(t.db, 'alert.enriched', alert.id)).toHaveLength(3);
  });

  it('a newer result replaces an older one, an older one never replaces a newer one', async () => {
    const alert = knownBadAlert();
    const m = moduleWith();
    const insert = (status: string, fetchedAt: string) =>
      t.db
        .insertInto('alert_enrichments')
        .values({
          alert_id: alert.id,
          provider: 'geo',
          indicator_type: 'ipv4',
          indicator_value: '203.0.113.66',
          status,
          verdict: null,
          data: null,
          error: null,
          duration_ms: 1,
          fetched_at: fetchedAt,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    await insert('not_found', '2030-01-01T00:00:00Z'); // from the future: newer than anything we fetch now
    await m.api.enrichAlert(alert);
    const geo = (await m.api.getForAlert(alert.id)).find(
      (r) => r.provider === 'geo' && r.indicator.value === '203.0.113.66',
    );
    expect(geo?.status).toBe('not_found');
    expect(geo?.fetchedAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('opens a breaker under sustained failure and reports circuit_open, then status shows it', async () => {
    const failing = [
      new ResilientEnricher(createReputationEnricher({ failureRate: 1 }), {
        ...DEFAULT_RESILIENCE,
        retry: { maxAttempts: 1, baseMs: 0, capMs: 0 },
        breaker: { ...DEFAULT_RESILIENCE.breaker, windowSize: 4, minimumCalls: 4 },
      }),
      new ResilientEnricher(createGeoEnricher()),
    ];
    // One lookup at a time, so the breaker sees each failure before the next call.
    const m = createEnrichmentModule(integrationDeps(t.db, { ENRICHMENT_CONCURRENCY: '1' }), {
      alertLookup: { get: () => Promise.resolve(null) },
      providers: failing,
    });
    const alert = knownBadAlert({
      host: {},
      indicators: [
        '203.0.113.66',
        '203.0.113.7',
        '198.51.100.23',
        '198.51.100.77',
        '192.0.2.10',
        '198.51.100.50',
      ].map((value) => ({ type: 'ipv4' as const, value })),
    });
    const results = await m.api.enrichAlert(alert);
    const reputation = results.filter((r) => r.provider === 'reputation').map((r) => r.status);
    expect(reputation.filter((s) => s === 'error')).toHaveLength(4);
    expect(reputation.filter((s) => s === 'circuit_open')).toHaveLength(2);
    expect(results.filter((r) => r.provider === 'geo').every((r) => r.status === 'ok')).toBe(true);
    expect(m.api.providerStatus().map((p) => `${p.name}:${p.circuit}`)).toEqual([
      'reputation:open',
      'geo:closed',
    ]);
  });

  it('POST /alerts/:id/enrich re-runs enrichment, returns 202 and publishes alert.enriched', async () => {
    const alert = knownBadAlert();
    const m = moduleWith([alert]);
    const server = await buildTestServer([m.module]);
    try {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/alerts/${alert.id}/enrich`,
        headers: as('analyst'),
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().alertId).toBe(alert.id);
      expect(res.json().enrichments).toHaveLength(5);
      expect(await outboxEvents(t.db, 'alert.enriched', alert.id)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('stores jsonb data that round-trips through the schema', async () => {
    const alert = knownBadAlert();
    const m = moduleWith();
    await m.api.enrichAlert(alert);
    const raw = await sql<{ kinds: string[] }>`
      select array_agg(distinct data->>'kind' order by data->>'kind') as kinds
      from alert_enrichments where alert_id = ${alert.id}`.execute(t.db);
    expect(raw.rows[0]?.kinds).toEqual(['asset', 'geo', 'reputation']);
  });
});
