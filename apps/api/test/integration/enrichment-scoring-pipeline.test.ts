import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnrichmentModule } from '../../src/modules/enrichment/index.js';
import { createScoringModule } from '../../src/modules/scoring/index.js';
import { InlineDeliveryQueue } from '../../src/platform/events/in-memory.js';
import { OutboxRelay } from '../../src/platform/events/outbox.js';
import { EventSubscriptions } from '../../src/platform/events/types.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { integrationDeps, knownBadAlert, outboxEvents } from './enrichment-scoring.support.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

/**
 * The real path of sequence diagram 1 (docs/architecture/sequences.md), minus Redis:
 * outbox → relay → enrichment handler → outbox → relay → scoring handler → outbox.
 */
async function runPipeline(overrides: Record<string, string> = {}) {
  const deps = integrationDeps(t.db, overrides);
  const enrichment = createEnrichmentModule(deps, {
    alertLookup: { get: () => Promise.resolve(null) },
  });
  const scoring = createScoringModule(deps);
  const subscriptions = new EventSubscriptions();
  for (const m of [enrichment.module, scoring.module]) {
    for (const h of m.subscribers?.() ?? []) subscriptions.register(h);
  }
  const queue = new InlineDeliveryQueue(subscriptions);
  const relay = new OutboxRelay(t.db, subscriptions, queue, pino({ level: 'silent' }), {
    pollIntervalMs: 10,
    batchSize: 50,
  });
  const alert = knownBadAlert();
  await deps.events.publish(t.db, [
    { type: 'alert.ingested', aggregateId: alert.id, payload: { alert } },
  ]);
  while ((await relay.dispatchBatch()) > 0) {
    /* drain: each batch may publish the next stage's event */
  }
  return { alert, queue };
}

describe('alert.ingested → alert.enriched → alert.scored (integration)', () => {
  it('produces an explained critical score for a known-bad alert on a domain controller', async () => {
    const { alert, queue } = await runPipeline();
    expect(queue.failures).toEqual([]);
    const [scored] = await outboxEvents(t.db, 'alert.scored', alert.id);
    expect(scored?.payload.score).toMatchObject({ score: 100, severity: 'critical', dataGaps: [] });
    expect(scored?.payload.score.factors.map((f) => f.ruleId)).toEqual([
      'baseline',
      'malicious-indicator',
      'known-c2-infrastructure',
      'critical-asset',
      'credential-access-tactic',
      'credential-dumping-technique',
      'command-and-control-tactic',
    ]);
    expect(scored?.payload.score.factors.find((f) => f.ruleId === 'critical-asset')?.evidence).toBe(
      'dc01.corp.example',
    );
  });

  it('with every provider down, the alert is still scored and the explanation lists the gaps', async () => {
    const { alert, queue } = await runPipeline({
      ENRICHMENT_FAILURE_RATE: '1',
      ENRICHMENT_MAX_ATTEMPTS: '2',
    });
    expect(queue.failures).toEqual([]);
    const [enriched] = await outboxEvents(t.db, 'alert.enriched', alert.id);
    expect(new Set(enriched?.payload.enrichments.map((r) => r.status))).toEqual(new Set(['error']));
    const [scored] = await outboxEvents(t.db, 'alert.scored', alert.id);
    expect(scored?.payload.score.dataGaps).toEqual(['asset-inventory', 'geo', 'reputation']);
    expect(scored?.payload.score.factors.map((f) => f.ruleId)).toEqual([
      'baseline',
      'credential-access-tactic',
      'credential-dumping-technique',
      'command-and-control-tactic',
    ]);
  });
});
