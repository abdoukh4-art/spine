import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  Bulkhead,
  BulkheadRejectedError,
  CircuitBreaker,
  CircuitOpenError,
  composeResilience,
  DEFAULT_RESILIENCE,
  found,
  notFound,
  realScheduler,
  ResilientEnricher,
  sleep,
  TimeoutError,
  TransientProviderError,
  VirtualScheduler,
  type Enricher,
  type ResilienceConfig,
} from '../src/index.js';

const ip = { type: 'ipv4' as const, value: '203.0.113.66' };

function scripted(
  scheduler: VirtualScheduler,
  script: (call: number, signal: AbortSignal) => Promise<'found' | 'missing'>,
): Enricher & { calls: number } {
  const enricher = {
    name: 'scripted',
    indicatorTypes: ['ipv4'] as const,
    calls: 0,
    supports: (i: { type: string }) => i.type === 'ipv4',
    async lookup(_i: unknown, { signal }: { signal: AbortSignal }) {
      enricher.calls += 1;
      const r = await script(enricher.calls, signal);
      return r === 'found'
        ? found({ kind: 'reputation', score: 90, verdict: 'malicious', tags: [] })
        : notFound();
    },
  };
  void scheduler;
  return enricher;
}

const config: ResilienceConfig = {
  timeoutMs: 100,
  retry: { maxAttempts: 3, baseMs: 10, capMs: 50 },
  breaker: {
    failureRateThreshold: 0.5,
    windowSize: 2,
    minimumCalls: 2,
    cooldownMs: 1000,
    halfOpenMaxCalls: 1,
  },
  bulkhead: { maxConcurrent: 1, maxQueue: 0 },
};

describe('composeResilience', () => {
  it('applies the layers in ADR order: an open breaker skips retries entirely', async () => {
    const scheduler = new VirtualScheduler();
    const breaker = new CircuitBreaker({ ...config.breaker, scheduler });
    const call = composeResilience({
      bulkhead: new Bulkhead(2, 2),
      breaker,
      timeoutMs: 100,
      retry: { maxAttempts: 3, baseMs: 0, capMs: 0 },
      scheduler,
    });
    let attempts = 0;
    const failing = (): Promise<never> => {
      attempts += 1;
      return Promise.reject(new TransientProviderError('503'));
    };
    for (let i = 0; i < 2; i += 1) {
      const p = call(failing).catch((e: unknown) => e);
      await scheduler.runAll();
      expect(await p).toBeInstanceOf(TransientProviderError);
    }
    expect(attempts).toBe(6); // 2 logical calls x 3 attempts, counted twice by the breaker
    expect(breaker.state).toBe('open');
    await expect(call(failing)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(attempts).toBe(6);
  });

  it('works without an explicit scheduler (real timers)', async () => {
    const call = composeResilience({
      bulkhead: new Bulkhead(1, 0),
      breaker: new CircuitBreaker(DEFAULT_RESILIENCE.breaker),
      timeoutMs: 1000,
      retry: DEFAULT_RESILIENCE.retry,
    });
    await expect(call(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(realScheduler.now()).toBeGreaterThan(0);
  });
});

describe('ResilientEnricher', () => {
  it('returns the outcome and reports a healthy status', async () => {
    const scheduler = new VirtualScheduler();
    const provider = new ResilientEnricher(
      scripted(scheduler, () => Promise.resolve('found')),
      config,
      { scheduler },
    );
    await expect(provider.lookup(ip)).resolves.toMatchObject({ kind: 'found' });
    expect(provider.supports(ip)).toBe(true);
    expect(provider.status()).toEqual({
      name: 'scripted',
      supports: ['ipv4'],
      circuit: 'closed',
      inFlight: 0,
      queued: 0,
    });
  });

  it('times out a slow attempt per attempt and recovers on retry', async () => {
    const scheduler = new VirtualScheduler();
    const retries: number[] = [];
    const enricher = scripted(scheduler, (call, signal) =>
      call === 1
        ? sleep(scheduler, 500, signal).then(() => 'found' as const)
        : Promise.resolve('missing' as const),
    );
    const provider = new ResilientEnricher(enricher, config, {
      scheduler,
      random: () => 0.5,
      onRetry: (_name, info) => retries.push(info.attempt),
    });
    const p = provider.lookup(ip);
    await scheduler.runAll();
    await expect(p).resolves.toEqual({ kind: 'not_found' });
    expect(enricher.calls).toBe(2);
    expect(retries).toEqual([1]);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it('surfaces TimeoutError after the last attempt and opens its breaker', async () => {
    const scheduler = new VirtualScheduler();
    const changes: string[] = [];
    const provider = new ResilientEnricher(
      scripted(scheduler, (_c, signal) =>
        sleep(scheduler, 10_000, signal).then(() => 'found' as const),
      ),
      config,
      { scheduler, onStateChange: (name, c) => changes.push(`${name}:${c.from}>${c.to}`) },
    );
    for (let i = 0; i < 2; i += 1) {
      const p = provider.lookup(ip).catch((e: unknown) => e);
      await scheduler.runAll();
      expect(await p).toBeInstanceOf(TimeoutError);
    }
    expect(changes).toEqual(['scripted:closed>open']);
    expect(provider.status().circuit).toBe('open');
  });

  it('rejects with BulkheadRejectedError when saturated', async () => {
    const scheduler = new VirtualScheduler();
    const provider = new ResilientEnricher(
      scripted(scheduler, (_c, signal) =>
        sleep(scheduler, 50, signal).then(() => 'found' as const),
      ),
      config,
      { scheduler },
    );
    const first = provider.lookup(ip);
    expect(provider.status().inFlight).toBe(1);
    await expect(provider.lookup(ip)).rejects.toBeInstanceOf(BulkheadRejectedError);
    await scheduler.runAll();
    await expect(first).resolves.toMatchObject({ kind: 'found' });
  });

  it('stops at once when the caller aborts, without counting a breaker failure', async () => {
    const scheduler = new VirtualScheduler();
    const provider = new ResilientEnricher(
      scripted(scheduler, (_c, signal) =>
        sleep(scheduler, 50, signal).then(() => 'found' as const),
      ),
      config,
      { scheduler },
    );
    const caller = new AbortController();
    const p = provider.lookup(ip, caller.signal);
    caller.abort(new AbortedError('shutdown'));
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(provider.breaker.failureRate).toBe(0);
  });

  it('uses the defaults when no config or options are given', async () => {
    const provider = new ResilientEnricher(
      scripted(new VirtualScheduler(), () => Promise.resolve('found')),
    );
    await expect(provider.lookup(ip)).resolves.toMatchObject({ kind: 'found' });
    expect(provider.bulkhead.maxConcurrent).toBe(DEFAULT_RESILIENCE.bulkhead.maxConcurrent);
  });
});
