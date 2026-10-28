import { EnrichmentResultSchema, type Indicator, type ProviderStatus } from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BulkheadRejectedError,
  CircuitOpenError,
  createMockEnrichers,
  EnrichmentService,
  ResilientEnricher,
  statusForError,
  TimeoutError,
  VirtualScheduler,
  type LookupOutcome,
  type ResilientProvider,
} from '../src/index.js';

function fake(
  name: string,
  behaviour: (i: Indicator) => Promise<LookupOutcome>,
  supports: (i: Indicator) => boolean = () => true,
): ResilientProvider & { seen: Indicator[] } {
  const seen: Indicator[] = [];
  return {
    name,
    seen,
    supports,
    lookup: (i) => {
      seen.push(i);
      return behaviour(i);
    },
    status: (): ProviderStatus => ({
      name,
      supports: [],
      circuit: 'closed',
      inFlight: 0,
      queued: 0,
    }),
  };
}

const alert = {
  indicators: [
    { type: 'ipv4' as const, value: '203.0.113.66' },
    { type: 'domain' as const, value: 'EVIL.example' },
    { type: 'domain' as const, value: 'evil.example' }, // duplicate after normalization
  ],
  host: { hostname: 'DC01.corp.example', ips: ['10.10.0.10'] },
};

describe('EnrichmentService', () => {
  it('looks up every supported (indicator, provider) pair, de-duplicated, in a stable order', async () => {
    const a = fake('a', () => Promise.resolve({ kind: 'not_found' }));
    const b = fake(
      'b',
      () => Promise.resolve({ kind: 'not_found' }),
      (i) => i.type === 'domain',
    );
    const results = await new EnrichmentService([a, b]).enrich(alert);
    expect(results.map((r) => `${r.provider}:${r.indicator.type}:${r.indicator.value}`)).toEqual([
      'a:ipv4:203.0.113.66',
      'a:domain:evil.example',
      'b:domain:evil.example',
      'a:hostname:dc01.corp.example',
      'a:ipv4:10.10.0.10',
    ]);
    for (const r of results) expect(EnrichmentResultSchema.safeParse(r).success).toBe(true);
  });

  it('maps outcomes and failures to statuses and never throws', async () => {
    const scheduler = new VirtualScheduler(Date.parse('2026-10-28T10:00:00Z'));
    const providers = [
      fake('ok', () =>
        Promise.resolve({
          kind: 'found',
          data: { kind: 'reputation', score: 96, verdict: 'malicious', tags: ['c2'] },
        }),
      ),
      fake('geo', () => Promise.resolve({ kind: 'found', data: { kind: 'geo', isTor: true } })),
      fake('slow', () => Promise.reject(new TimeoutError(100))),
      fake('open', () => Promise.reject(new CircuitOpenError(10))),
      fake('full', () => Promise.reject(new BulkheadRejectedError(1, 0))),
      fake('bug', () => Promise.reject(new Error('x'.repeat(900)))),
      fake('weird', () => Promise.reject('a string')), // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
      fake(
        'picky',
        () => Promise.resolve({ kind: 'not_found' }),
        () => {
          throw new Error('buggy supports');
        },
      ),
    ];
    const results = await new EnrichmentService(providers, { scheduler }).enrich({
      indicators: [{ type: 'ipv4', value: '203.0.113.66' }],
    });
    const byProvider = Object.fromEntries(results.map((r) => [r.provider, r]));
    expect(byProvider.ok).toMatchObject({ status: 'ok', verdict: 'malicious' });
    expect(byProvider.geo).toMatchObject({ status: 'ok' });
    expect(byProvider.geo?.verdict).toBeUndefined();
    expect(byProvider.slow).toMatchObject({ status: 'timeout' });
    expect(byProvider.open).toMatchObject({ status: 'circuit_open' });
    expect(byProvider.full).toMatchObject({ status: 'rejected' });
    expect(byProvider.bug?.status).toBe('error');
    expect(byProvider.bug?.error).toHaveLength(500);
    expect(byProvider.weird).toMatchObject({ status: 'error', error: 'a string' });
    expect(byProvider.picky).toBeUndefined();
    expect(byProvider.ok?.fetchedAt).toBe('2026-10-28T10:00:00.000Z');
    for (const r of results) expect(EnrichmentResultSchema.safeParse(r).success).toBe(true);
  });

  it('prefers an explicit verdict from the provider', async () => {
    const p = fake('asset', () =>
      Promise.resolve({
        kind: 'found',
        data: { kind: 'asset', hostname: 'h', criticality: 'high', tags: [] },
        verdict: 'unknown',
      }),
    );
    const [r] = await new EnrichmentService([p]).enrich({
      indicators: [{ type: 'hostname', value: 'h' }],
    });
    expect(r?.verdict).toBe('unknown');
  });

  it('measures duration with the injected clock and reports each result', async () => {
    const scheduler = new VirtualScheduler();
    const reported: string[] = [];
    const slow = fake('slow', async () => {
      await new Promise<void>((resolve) => scheduler.setTimer(resolve, 120));
      return { kind: 'not_found' };
    });
    const service = new EnrichmentService([slow], {
      scheduler,
      onResult: (r) => reported.push(`${r.provider}:${r.status}`),
    });
    const p = service.enrich({ indicators: [{ type: 'ipv4', value: '203.0.113.1' }] });
    await scheduler.runAll();
    const [r] = await p;
    expect(r?.durationMs).toBe(120);
    expect(reported).toEqual(['slow:not_found']);
  });

  it('can be restricted to some providers, and exposes names and status', async () => {
    const a = fake('a', () => Promise.resolve({ kind: 'not_found' }));
    const b = fake('b', () => Promise.resolve({ kind: 'not_found' }));
    const service = new EnrichmentService([a, b]);
    const results = await service.enrich(alert, { providers: ['b'] });
    expect(new Set(results.map((r) => r.provider))).toEqual(new Set(['b']));
    expect(a.seen).toHaveLength(0);
    expect(service.providerNames()).toEqual(['a', 'b']);
    expect(service.status().map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('returns no results for an alert without indicators or host', async () => {
    const service = new EnrichmentService([
      fake('a', () => Promise.resolve({ kind: 'not_found' })),
    ]);
    await expect(service.enrich({ indicators: [] })).resolves.toEqual([]);
  });

  it('rejects duplicate provider names', () => {
    const a = fake('a', () => Promise.resolve({ kind: 'not_found' }));
    expect(() => new EnrichmentService([a, a])).toThrow(/unique/);
  });

  it('maps errors to statuses', () => {
    expect(statusForError(new TimeoutError(1))).toBe('timeout');
    expect(statusForError(new CircuitOpenError(1))).toBe('circuit_open');
    expect(statusForError(new BulkheadRejectedError(1, 1))).toBe('rejected');
    expect(statusForError(new Error('x'))).toBe('error');
  });

  it('property: bounded concurrency, one result per task, never rejects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        async (s, concurrency, failures) => {
          let inFlight = 0;
          let maxInFlight = 0;
          let call = 0;
          const provider = fake('p', async () => {
            const fail = failures[call++] ?? false;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await s.schedule(Promise.resolve());
            inFlight -= 1;
            if (fail) throw new Error('down');
            return { kind: 'not_found' };
          });
          const indicators = failures.map((_, i) => ({
            type: 'ipv4' as const,
            value: `203.0.113.${i}`,
          }));
          const results = await s.waitFor(
            new EnrichmentService([provider], { concurrency }).enrich({ indicators }),
          );
          expect(results).toHaveLength(failures.length);
          expect(maxInFlight).toBeLessThanOrEqual(concurrency);
          results.forEach((r, i) => {
            expect(r.indicator.value).toBe(`203.0.113.${i}`);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('end to end with the mock providers: realistic results for a known-bad alert', async () => {
    const providers = createMockEnrichers().map((e) => new ResilientEnricher(e));
    const results = await new EnrichmentService(providers).enrich({
      indicators: [
        { type: 'ipv4', value: '198.51.100.77' },
        { type: 'url', value: 'http://evil.example/login' },
      ],
      host: { hostname: 'dc01' },
    });
    const summary = results.map(
      (r) => `${r.provider}:${r.indicator.value}:${r.status}:${r.verdict ?? '-'}`,
    );
    expect(summary).toEqual([
      'reputation:198.51.100.77:ok:suspicious',
      'geo:198.51.100.77:ok:-',
      'reputation:http://evil.example/login:ok:malicious',
      'asset-inventory:dc01:ok:-',
    ]);
  });
});
