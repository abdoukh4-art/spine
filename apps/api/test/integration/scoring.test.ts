import type { DomainEvent, EnrichmentResult } from '@spine/shared-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScoringModule } from '../../src/modules/scoring/index.js';
import { uuidV7Generator } from '../../src/platform/runtime.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { integrationDeps, knownBadAlert, outboxEvents } from './enrichment-scoring.support.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

const scored: string[] = [];
function scoringModule() {
  return createScoringModule(integrationDeps(t.db), {
    metrics: { recordScored: (e) => scored.push(e.severity) },
  });
}
type Handler = { handle(e: DomainEvent<'alert.enriched'>): Promise<void> };
const handlerOf = (m: ReturnType<typeof scoringModule>) =>
  m.module.subscribers?.()[0] as unknown as Handler;

const malicious: EnrichmentResult = {
  provider: 'reputation',
  indicator: { type: 'ipv4', value: '203.0.113.66' },
  status: 'ok',
  verdict: 'malicious',
  data: { kind: 'reputation', score: 96, verdict: 'malicious', tags: ['c2'] },
  durationMs: 10,
  fetchedAt: '2026-10-28T10:00:01.000Z',
};
const assetTimeout: EnrichmentResult = {
  provider: 'asset-inventory',
  indicator: { type: 'hostname', value: 'dc01.corp.example' },
  status: 'timeout',
  error: 'timed out after 1000 ms',
  durationMs: 1000,
  fetchedAt: '2026-10-28T10:00:01.000Z',
};

function enrichedEvent(
  alert: ReturnType<typeof knownBadAlert>,
  enrichments: EnrichmentResult[],
  occurredAt: string,
): DomainEvent<'alert.enriched'> {
  return {
    eventId: uuidV7Generator.next(),
    type: 'alert.enriched',
    version: 1,
    aggregateId: alert.id,
    occurredAt,
    payload: { alert, enrichments },
  };
}

describe('scoring.on-alert-enriched (integration)', () => {
  it('scores, stores and publishes alert.scored with the full explanation', async () => {
    const alert = knownBadAlert();
    const m = scoringModule();
    await handlerOf(m).handle(
      enrichedEvent(alert, [malicious, assetTimeout], '2026-10-28T10:00:02Z'),
    );

    const events = await outboxEvents(t.db, 'alert.scored', alert.id);
    expect(events).toHaveLength(1);
    const score = events[0]!.payload.score;
    expect(score.factors.map((f) => f.ruleId)).toEqual([
      'baseline',
      'malicious-indicator',
      'known-c2-infrastructure',
      'credential-access-tactic',
      'credential-dumping-technique',
      'command-and-control-tactic',
    ]);
    expect(score).toMatchObject({
      rawScore: 120,
      score: 100,
      severity: 'critical',
      dataGaps: ['asset-inventory'],
    });
    expect(events[0]!.payload.enrichments).toHaveLength(2);
    expect(await m.api.getForAlert(alert.id)).toEqual(score);

    const row = await t.db
      .selectFrom('alert_scores')
      .selectAll()
      .where('alert_id', '=', alert.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ ruleset_version: 1, score: 100, severity: 'critical' });
    expect(row.source_occurred_at.toISOString()).toBe('2026-10-28T10:00:02.000Z');
  });

  it('is idempotent per alert + ruleset version: redeliveries publish nothing (ADR-0042)', async () => {
    const alert = knownBadAlert();
    const m = scoringModule();
    const event = enrichedEvent(alert, [malicious], '2026-10-28T10:00:02Z');
    scored.length = 0;
    // Concurrent first deliveries race on the INSERT; later ones take the FOR UPDATE path.
    await Promise.all([1, 2, 3].map(() => handlerOf(m).handle(event)));
    await handlerOf(m).handle(event);
    await Promise.all([1, 2].map(() => handlerOf(m).handle(event)));
    expect(await outboxEvents(t.db, 'alert.scored', alert.id)).toHaveLength(1);
    expect(scored).toEqual(['critical']); // metrics count published scores only
  });

  it('re-scores when newer enrichment changes the score, ignores stale snapshots', async () => {
    const alert = knownBadAlert({ mitre: [], severity: 'medium' });
    const m = scoringModule();
    const h = handlerOf(m);
    await h.handle(enrichedEvent(alert, [assetTimeout], '2026-10-28T10:00:01Z'));
    await h.handle(enrichedEvent(alert, [malicious], '2026-10-28T10:00:05Z'));
    // Identical to the stored score but newer: advances the snapshot time, publishes nothing.
    await h.handle(enrichedEvent(alert, [malicious], '2026-10-28T10:00:07Z'));
    // A stale snapshot (older than the latest) arriving late must not overwrite anything.
    await h.handle(enrichedEvent(alert, [], '2026-10-28T10:00:06Z'));

    const events = await outboxEvents(t.db, 'alert.scored', alert.id);
    expect(events.map((e) => e.payload.score.score)).toEqual([25, 65]);
    expect((await m.api.getForAlert(alert.id))?.score).toBe(65);
    const row = await t.db
      .selectFrom('alert_scores')
      .select('source_occurred_at')
      .where('alert_id', '=', alert.id)
      .executeTakeFirstOrThrow();
    expect(row.source_occurred_at.toISOString()).toBe('2026-10-28T10:00:07.000Z');
  });

  it('scoreAndStore persists via the public API; getForAlert is null for unknown alerts', async () => {
    const alert = knownBadAlert();
    const m = scoringModule();
    const e = await m.api.scoreAndStore(alert, []);
    expect(e.factors[0]?.ruleId).toBe('baseline');
    expect(await outboxEvents(t.db, 'alert.scored', alert.id)).toHaveLength(1);
    expect(await m.api.getForAlert(uuidV7Generator.next())).toBeNull();
  });
});
