import type { DomainEvent, EnrichmentResult, ProviderStatus } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import { EnrichmentApplication } from '../../../src/modules/enrichment/application/enrichment-app.js';
import type {
  AlertEnricher,
  EnrichmentRepository,
  EnrichmentTransaction,
} from '../../../src/modules/enrichment/application/ports.js';
import { circuitGaugeValue } from '../../../src/modules/enrichment/domain/circuit-gauge.js';
import { NotFoundError } from '../../../src/platform/errors.js';
import { ManualClock } from '../../../src/platform/runtime.js';
import { results, testAlert } from '../scoring/fixtures.js';

/** In-memory repository with the same merge rules as the Postgres adapter (ADR-0041). */
class InMemoryRepository implements EnrichmentRepository {
  readonly processed = new Set<string>();
  readonly rows = new Map<string, EnrichmentResult>();
  readonly published: { type: string; payload: unknown }[] = [];
  /** Simulates a concurrent delivery committing between the pre-check and the transaction. */
  raceOnNextMark = false;

  transaction<T>(work: (tx: EnrichmentTransaction) => Promise<T>): Promise<T> {
    return work({
      markProcessed: (eventId) => {
        if (this.raceOnNextMark || this.processed.has(eventId)) return Promise.resolve(false);
        this.processed.add(eventId);
        return Promise.resolve(true);
      },
      upsertResults: (alertId, list) => {
        for (const r of list) {
          const key = `${alertId}|${r.provider}|${r.indicator.type}|${r.indicator.value}`;
          const old = this.rows.get(key);
          const failed = (s: string) =>
            ['error', 'timeout', 'circuit_open', 'rejected'].includes(s);
          if (!old || !failed(r.status) || failed(old.status)) this.rows.set(key, r);
        }
        return Promise.resolve();
      },
      listForAlert: (alertId) => this.listForAlert(alertId),
      publish: (events) => {
        this.published.push(...events.map((e) => ({ type: e.type, payload: e.payload })));
        return Promise.resolve();
      },
    });
  }
  listForAlert(alertId: string): Promise<EnrichmentResult[]> {
    return Promise.resolve(
      [...this.rows.entries()].filter(([k]) => k.startsWith(`${alertId}|`)).map(([, v]) => v),
    );
  }
  wasProcessed(eventId: string): Promise<boolean> {
    return Promise.resolve(this.processed.has(eventId));
  }
}

function enricher(script: EnrichmentResult[][]): AlertEnricher & { calls: number } {
  const status: ProviderStatus[] = [
    { name: 'reputation', supports: ['ipv4'], circuit: 'closed', inFlight: 0, queued: 0 },
  ];
  const e = {
    calls: 0,
    enrich: () => Promise.resolve(script[Math.min(e.calls++, script.length - 1)] ?? []),
    status: () => status,
  };
  return e;
}

function setup(script: EnrichmentResult[][], alertExists = true) {
  const repository = new InMemoryRepository();
  const provider = enricher(script);
  const alert = testAlert();
  const app = new EnrichmentApplication({
    enricher: provider,
    repository,
    alerts: { get: (id) => Promise.resolve(alertExists && id === alert.id ? alert : null) },
    clock: new ManualClock('2026-10-28T10:00:00Z'),
  });
  return { app, repository, provider, alert };
}

describe('EnrichmentApplication', () => {
  it('enriches an ingested alert and publishes alert.enriched with the stored results', async () => {
    const { app, repository, alert } = setup([
      [results.malicious(), results.failed('geo', 'timeout')],
    ]);
    await expect(app.handleIngested('evt-1', alert)).resolves.toEqual({
      kind: 'enriched',
      results: 2,
      failed: 1,
    });
    expect(repository.published).toHaveLength(1);
    const payload = repository.published[0]?.payload as DomainEvent<'alert.enriched'>['payload'];
    expect(payload.alert.id).toBe(alert.id);
    expect(payload.enrichments.map((r) => r.status).sort()).toEqual(['ok', 'timeout']);
  });

  it('skips a redelivered event without calling providers again (ADR-0040)', async () => {
    const { app, repository, provider, alert } = setup([[results.malicious()]]);
    await app.handleIngested('evt-1', alert);
    await expect(app.handleIngested('evt-1', alert)).resolves.toEqual({ kind: 'duplicate' });
    expect(provider.calls).toBe(1);
    expect(repository.published).toHaveLength(1);
  });

  it('writes and publishes nothing when a concurrent delivery won the race', async () => {
    const { app, repository, alert } = setup([[results.malicious()]]);
    repository.raceOnNextMark = true;
    await expect(app.handleIngested('evt-1', alert)).resolves.toEqual({ kind: 'duplicate' });
    expect(repository.rows.size).toBe(0);
    expect(repository.published).toHaveLength(0);
  });

  it('re-enrichment keeps an earlier success when the provider now fails (ADR-0041)', async () => {
    const ok = results.malicious();
    const failedNow = { ...results.failed('reputation', 'circuit_open'), indicator: ok.indicator };
    const { app, alert } = setup([[ok], [failedNow]]);
    await app.enrichAlert(alert);
    const merged = await app.enrichAlert(alert);
    expect(merged).toEqual([ok]);
    expect(await app.getForAlert(alert.id)).toEqual([ok]);
  });

  it('re-enriches by id and 404s an unknown alert', async () => {
    const { app, alert, repository } = setup([[results.malicious()]]);
    await expect(app.reEnrichById(alert.id)).resolves.toHaveLength(1);
    expect(repository.published).toHaveLength(1);
    await expect(app.reEnrichById('00000000-0000-7000-8000-00000000ffff')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('publishes alert.enriched even when there is nothing to look up', async () => {
    const { app, repository, alert } = setup([[]]);
    await expect(app.handleIngested('evt-9', alert)).resolves.toMatchObject({ results: 0 });
    expect(repository.published).toHaveLength(1);
  });

  it('exposes provider status', () => {
    expect(setup([[]]).app.providerStatus()[0]?.name).toBe('reputation');
  });
});

describe('circuitGaugeValue', () => {
  it('encodes closed/half_open/open as 0/1/2', () => {
    expect(['closed', 'half_open', 'open'].map((s) => circuitGaugeValue(s as never))).toEqual([
      0, 1, 2,
    ]);
  });
});
