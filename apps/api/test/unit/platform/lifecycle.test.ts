import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown } from '../../../src/platform/lifecycle.js';
import { EventSubscriptions } from '../../../src/platform/events/types.js';
import { ManualClock, SequentialIdGenerator } from '../../../src/platform/runtime.js';

describe('graceful shutdown', () => {
  it('runs closers in order and exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = installGracefulShutdown({
      logger: pino({ level: 'silent' }),
      timeoutMs: 1000,
      exit,
      closers: [
        { name: 'http', close: () => Promise.resolve(void order.push('http')) },
        { name: 'db', close: () => Promise.resolve(void order.push('db')) },
      ],
    });
    await shutdown();
    expect(order).toEqual(['http', 'db']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('continues past a failing closer and exits 1', async () => {
    const exit = vi.fn();
    const closed: string[] = [];
    const shutdown = installGracefulShutdown({
      logger: pino({ level: 'silent' }),
      timeoutMs: 1000,
      exit,
      closers: [
        { name: 'bad', close: () => Promise.reject(new Error('x')) },
        { name: 'db', close: () => Promise.resolve(void closed.push('db')) },
      ],
    });
    await shutdown();
    expect(closed).toEqual(['db']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('runtime helpers', () => {
  it('ManualClock advances deterministically', () => {
    const clock = new ManualClock('2026-01-01T00:00:00Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
  });
  it('SequentialIdGenerator yields valid, ordered UUIDs', () => {
    const ids = new SequentialIdGenerator();
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000001');
    expect(ids.next() < ids.next()).toBe(true);
  });
});

describe('EventSubscriptions', () => {
  it('indexes handlers by type and rejects duplicate names', () => {
    const subs = new EventSubscriptions();
    const h = {
      name: 'enrich',
      eventType: 'alert.ingested' as const,
      handle: () => Promise.resolve(),
    };
    subs.register(h);
    expect(subs.handlersFor('alert.ingested')).toHaveLength(1);
    expect(subs.handlersFor('alert.scored')).toHaveLength(0);
    expect(subs.byHandlerName('enrich')).toBeDefined();
    expect(() => subs.register(h)).toThrow(/duplicate/);
  });
});
