import type { Alert, CanonicalAlert } from '@spine/shared-schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, IdempotencyKeyReusedError } from '../../../platform/errors.js';
import { RecordingEventPublisher } from '../../../platform/events/in-memory.js';
import type { DbExecutor } from '../../../platform/events/types.js';
import { ManualClock, SequentialIdGenerator } from '../../../platform/runtime.js';
import { OpenAlertExistsError, type AlertsPublicApi } from '../../alerts/public-api.js';
import { requestHash } from '../domain/idempotency.js';
import { BackpressureGuard } from './backpressure.js';
import { IngestAlert } from './ingest-alert.js';
import { IngestBatch } from './ingest-batch.js';
import type { IdempotencyStore, StoredResponse } from './ports.js';

const trx = {} as DbExecutor;

/** In-memory alerts store that can simulate losing the open-fingerprint race. */
class FakeAlerts implements AlertsPublicApi {
  readonly byId = new Map<string, Alert>();
  /** When > 0, `create` first stores a competitor's alert, then throws (a lost race). */
  loseRaces = 0;

  get(id: string) {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  statsReceivedBetween(): never {
    throw new Error('reporting is not used by ingestion');
  }
  setStatus(): Promise<void> {
    return Promise.resolve();
  }
  findOpenByFingerprint(_trx: DbExecutor, fingerprint: string) {
    const open = [...this.byId.values()].find(
      (a) =>
        a.fingerprint === fingerprint && a.status !== 'resolved' && a.status !== 'false_positive',
    );
    return Promise.resolve(open ? { alertId: open.id, duplicateCount: open.duplicateCount } : null);
  }
  recordDuplicate(_trx: DbExecutor, alertId: string, seenAt: string) {
    const a = this.byId.get(alertId)!;
    a.duplicateCount += 1;
    a.lastSeenAt = seenAt;
    return Promise.resolve({ duplicateCount: a.duplicateCount, lastSeenAt: seenAt });
  }
  create(_trx: DbExecutor, alert: Alert) {
    if (this.loseRaces > 0) {
      this.loseRaces -= 1;
      const winnerId = `0000000${this.loseRaces}-0000-7000-8000-00000000000a`;
      this.byId.set(winnerId, { ...alert, id: winnerId });
      return Promise.reject(new OpenAlertExistsError(alert.fingerprint));
    }
    this.byId.set(alert.id, { ...alert });
    return Promise.resolve();
  }
}

class FakeIdempotency implements IdempotencyStore {
  readonly records = new Map<string, StoredResponse & { createdAt: Date }>();
  /** When true, the next save reports a live conflict after storing a competitor's record. */
  raceOnSave: StoredResponse | null = null;

  find(_t: DbExecutor, scope: string, key: string, notBefore: Date) {
    const r = this.records.get(`${scope}|${key}`);
    return Promise.resolve(r && r.createdAt >= notBefore ? r : null);
  }
  save(
    _t: DbExecutor,
    record: { scope: string; key: string; response: StoredResponse; createdAt: Date },
  ) {
    const id = `${record.scope}|${record.key}`;
    if (this.raceOnSave) {
      this.records.set(id, { ...this.raceOnSave, createdAt: record.createdAt });
      this.raceOnSave = null;
      return Promise.resolve(false);
    }
    this.records.set(id, { ...record.response, createdAt: record.createdAt });
    return Promise.resolve(true);
  }
  deleteExpired() {
    return Promise.resolve(0);
  }
}

const alertInput: CanonicalAlert = {
  source: { vendor: 'Acme', product: 'EdgeWall', sourceAlertId: 'EW-1' },
  title: 'Brute force login attempt',
  category: 'credential_access',
  severity: 'high',
  occurredAt: '2026-10-28T09:30:00.000Z',
  indicators: [{ type: 'ipv4', value: '203.0.113.5' }],
  mitre: [],
  labels: {},
};

let alerts: FakeAlerts;
let idem: FakeIdempotency;
let events: RecordingEventPublisher;
let clock: ManualClock;
let ingest: IngestAlert;

beforeEach(() => {
  alerts = new FakeAlerts();
  idem = new FakeIdempotency();
  clock = new ManualClock('2026-10-28T10:00:00.000Z');
  events = new RecordingEventPublisher(clock);
  ingest = new IngestAlert({
    alerts,
    events,
    idempotency: idem,
    clock,
    ids: new SequentialIdGenerator(),
    tx: { run: (fn) => fn(trx) },
    maxAttempts: 3,
  });
});

describe('IngestAlert', () => {
  it('creates a new alert and emits alert.ingested with the full snapshot', async () => {
    const out = await ingest.execute({ alert: alertInput });
    expect(out).toEqual({
      kind: 'fresh',
      status: 202,
      result: { alertId: '00000000-0000-7000-8000-000000000001', status: 'created' },
    });
    const [event] = events.ofType('alert.ingested');
    expect(event?.payload.alert).toMatchObject({
      id: '00000000-0000-7000-8000-000000000001',
      status: 'new',
      receivedAt: '2026-10-28T10:00:00.000Z',
      lastSeenAt: '2026-10-28T10:00:00.000Z',
      duplicateCount: 0,
    });
    expect(event?.payload.alert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deduplicates into the open alert and emits alert.deduplicated', async () => {
    const first = await ingest.execute({ alert: alertInput });
    clock.advance(60_000);
    const second = await ingest.execute({ alert: { ...alertInput, title: 'changed title' } });
    expect(second.result).toEqual({
      alertId: first.result.alertId,
      status: 'deduplicated',
      duplicateOf: first.result.alertId,
    });
    expect(events.ofType('alert.deduplicated')[0]?.payload).toMatchObject({
      alertId: first.result.alertId,
      duplicateCount: 1,
      lastSeenAt: '2026-10-28T10:01:00.000Z',
    });
  });

  it('retries after losing the insert race and records a duplicate instead', async () => {
    alerts.loseRaces = 1;
    const out = await ingest.execute({ alert: alertInput });
    expect(out.result.status).toBe('deduplicated');
    expect(events.ofType('alert.ingested')).toHaveLength(0);
  });

  it('gives up with a ConflictError after maxAttempts lost races', async () => {
    alerts.loseRaces = 3;
    alerts.findOpenByFingerprint = () => Promise.resolve(null);
    await expect(ingest.execute({ alert: alertInput })).rejects.toBeInstanceOf(ConflictError);
  });

  it('propagates unexpected errors without retrying', async () => {
    alerts.create = () => Promise.reject(new Error('db down'));
    await expect(ingest.execute({ alert: alertInput })).rejects.toThrow('db down');
  });

  it('replays the stored response for the same key and body', async () => {
    const idempotency = { scope: 'user:u1', key: 'k1', requestHash: requestHash(alertInput) };
    const first = await ingest.execute({ alert: alertInput, idempotency });
    const again = await ingest.execute({ alert: alertInput, idempotency });
    expect(again).toEqual({ kind: 'replay', status: 202, result: first.result });
    expect(events.published).toHaveLength(1);
  });

  it('rejects a key reused with a different body', async () => {
    await ingest.execute({
      alert: alertInput,
      idempotency: { scope: 'user:u1', key: 'k1', requestHash: requestHash(alertInput) },
    });
    await expect(
      ingest.execute({
        alert: alertInput,
        idempotency: { scope: 'user:u1', key: 'k1', requestHash: requestHash({ other: true }) },
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('treats records older than 24 h as absent', async () => {
    const idempotency = { scope: 'user:u1', key: 'k1', requestHash: requestHash(alertInput) };
    await ingest.execute({ alert: alertInput, idempotency });
    clock.advance(24 * 3600 * 1000 + 1);
    const later = await ingest.execute({ alert: alertInput, idempotency });
    expect(later.kind).toBe('fresh');
  });

  it('replays the winner when a concurrent request stored the same key first', async () => {
    const winner: StoredResponse = {
      requestHash: requestHash(alertInput),
      status: 202,
      body: { alertId: '00000000-0000-7000-8000-0000000000ff', status: 'created' },
    };
    idem.raceOnSave = winner;
    const out = await ingest.execute({
      alert: alertInput,
      idempotency: { scope: 'user:u1', key: 'k1', requestHash: winner.requestHash },
    });
    expect(out).toEqual({ kind: 'replay', status: 202, result: winner.body });
  });
});

describe('IngestBatch', () => {
  it('reports per-line outcomes with 1-based line numbers and caps the error list', async () => {
    const good = JSON.stringify(alertInput);
    const bad = Array.from({ length: 105 }, () => '{"title":""}');
    // Duplicates *within* a batch are covered by the integration test: lines run concurrently,
    // and only the real unique index makes that race safe.
    const body = [good, '', '{not json', ...bad].join('\n');
    const result = await new IngestBatch(ingest).execute(
      body,
      'ndjson',
      '2026-10-28T10:00:00.000Z',
    );
    expect(result.accepted).toBe(1);
    expect(result.deduplicated).toBe(0);
    expect(result.rejected).toBe(106);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(100);
    expect(result.errors[0]).toEqual({ line: 3, message: 'payload is not valid JSON' });
    expect(result.errors[1]?.line).toBe(4);
    expect(result.errors[1]?.message).toContain('canonical alert schema');
  });

  it('counts non-alert Suricata events as skipped and business errors as rejected', async () => {
    alerts.loseRaces = 5;
    alerts.findOpenByFingerprint = () => Promise.resolve(null);
    const eve = [
      '{"event_type":"flow","timestamp":"2026-10-28T09:00:00Z"}',
      '{"event_type":"alert","timestamp":"2026-10-28T09:00:00Z","alert":{"signature":"x","severity":1}}',
    ].join('\r\n');
    const result = await new IngestBatch(ingest).execute(
      eve,
      'suricata-eve',
      '2026-10-28T10:00:00Z',
    );
    expect(result).toMatchObject({ skipped: 1, rejected: 1, accepted: 0 });
    expect(result.errors[0]?.line).toBe(2);
  });

  it('fails the request on infrastructure errors', async () => {
    alerts.create = () => Promise.reject(new Error('db down'));
    await expect(
      new IngestBatch(ingest).execute(JSON.stringify(alertInput), 'ndjson', '2026-10-28T10:00:00Z'),
    ).rejects.toThrow('db down');
  });
});

describe('BackpressureGuard', () => {
  it('caches the backlog for a second and shares one in-flight probe', async () => {
    let calls = 0;
    let backlog = 5;
    const guard = new BackpressureGuard({
      probe: () => {
        calls += 1;
        return Promise.resolve(backlog);
      },
      clock,
      maxBacklog: 10,
    });
    await Promise.all([guard.check(), guard.check(), guard.check()]);
    expect(calls).toBe(1);
    backlog = 11;
    clock.advance(500);
    await guard.check(); // still cached
    expect(calls).toBe(1);
    clock.advance(600);
    await expect(guard.check()).rejects.toMatchObject({ slug: 'overloaded', retryAfterSeconds: 5 });
    expect(await guard.healthy()).toBe(false);
    expect(calls).toBe(2);
  });

  it('retries the probe after a failure instead of caching it', async () => {
    let fail = true;
    const guard = new BackpressureGuard({
      probe: () => (fail ? Promise.reject(new Error('db')) : Promise.resolve(0)),
      clock,
      maxBacklog: 10,
    });
    await expect(guard.check()).rejects.toThrow('db');
    fail = false;
    await expect(guard.check()).resolves.toBeUndefined();
  });
});
