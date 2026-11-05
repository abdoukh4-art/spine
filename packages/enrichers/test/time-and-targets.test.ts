import { describe, expect, it } from 'vitest';
import {
  abortReason,
  AbortedError,
  flushPromises,
  found,
  isAbortError,
  lookupTargets,
  normalizeIndicator,
  realScheduler,
  sleep,
  toError,
  VirtualScheduler,
} from '../src/index.js';

describe('sleep and schedulers', () => {
  it('resolves after the delay on a virtual scheduler', async () => {
    const scheduler = new VirtualScheduler(100);
    let done = false;
    void sleep(scheduler, 50).then(() => (done = true));
    await scheduler.advance(49);
    expect(done).toBe(false);
    await scheduler.advance(1);
    expect(done).toBe(true);
    expect(scheduler.now()).toBe(150);
  });

  it('rejects with the abort reason and cancels its timer', async () => {
    const scheduler = new VirtualScheduler();
    const controller = new AbortController();
    const p = sleep(scheduler, 1000, controller.signal);
    controller.abort('plain reason');
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(scheduler.pendingTimers).toBe(0);
    await expect(sleep(scheduler, 1, controller.signal)).rejects.toThrow('plain reason');
  });

  it('the real scheduler can schedule and cancel timers', async () => {
    let fired = false;
    const cancel = realScheduler.setTimer(() => (fired = true), 5);
    cancel();
    await sleep(realScheduler, 10);
    expect(fired).toBe(false);
  });

  it('runAll guards against runaway timer loops', async () => {
    const scheduler = new VirtualScheduler();
    const loop = (): void => {
      scheduler.setTimer(loop, 1);
    };
    loop();
    await expect(scheduler.runAll(20)).rejects.toThrow(/more than 20 timers/);
    await flushPromises();
  });

  it('normalizes errors and recognizes aborts', () => {
    expect(toError('x').message).toBe('x');
    const e = new Error('y');
    expect(toError(e)).toBe(e);
    expect(isAbortError(new AbortedError())).toBe(true);
    const domAbort = new Error('aborted');
    domAbort.name = 'AbortError';
    expect(isAbortError(domAbort)).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(abortReason(controller.signal))).toBe(true);
  });
});

describe('lookup targets', () => {
  it('normalizes case-insensitive types only', () => {
    expect(normalizeIndicator({ type: 'domain', value: ' Evil.Example ' }).value).toBe(
      'evil.example',
    );
    expect(normalizeIndicator({ type: 'url', value: 'http://x.example/A' }).value).toBe(
      'http://x.example/A',
    );
  });

  it('adds the host and drops duplicates and empty values', () => {
    expect(
      lookupTargets({
        indicators: [
          { type: 'ipv4', value: '10.10.0.10' },
          { type: 'hostname', value: '  ' },
        ],
        host: { hostname: 'DC01', ips: ['10.10.0.10', 'fd00::10'] },
      }),
    ).toEqual([
      { type: 'ipv4', value: '10.10.0.10' },
      { type: 'hostname', value: 'dc01' },
      { type: 'ipv6', value: 'fd00::10' },
    ]);
  });

  it('found() omits an undefined verdict', () => {
    expect(found({ kind: 'geo', isTor: false })).toEqual({
      kind: 'found',
      data: { kind: 'geo', isTor: false },
    });
  });
});
