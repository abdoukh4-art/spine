import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  createAssetInventoryEnricher,
  createGeoEnricher,
  createMockEnrichers,
  createReputationEnricher,
  isPrivateIp,
  mulberry32,
  TransientProviderError,
  VirtualScheduler,
  type Enricher,
} from '../src/index.js';
import type { Indicator } from '@spine/shared-schema';

const signal = new AbortController().signal;
const lookup = (e: Enricher, i: Indicator) => e.lookup(i, { signal });

describe('mulberry32', () => {
  it('is deterministic per seed and uniform-ish in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('isPrivateIp', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.10.42', true],
    ['127.0.0.1', true],
    ['169.254.1.1', true],
    ['203.0.113.66', false],
    ['999.1.1.1', false],
    ['1.2.3', false],
    ['fd00::10', true],
    ['fe80::1', true],
    ['::1', true],
    ['2001:db8::bad', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('reputation mock', () => {
  const rep = createReputationEnricher();

  it('returns score, verdict and tags for known indicators (case-insensitive where it should be)', async () => {
    await expect(lookup(rep, { type: 'domain', value: 'EVIL.example' })).resolves.toEqual({
      kind: 'found',
      verdict: 'malicious',
      data: {
        kind: 'reputation',
        score: 92,
        verdict: 'malicious',
        tags: ['phishing', 'credential-harvesting'],
      },
    });
    await expect(lookup(rep, { type: 'ipv4', value: '203.0.113.66' })).resolves.toMatchObject({
      data: { firstSeen: '2026-09-14T08:12:00.000Z' },
    });
    await expect(
      lookup(rep, { type: 'md5', value: '44D88612FEA8A8F36DE82E1278ABB02F' }),
    ).resolves.toMatchObject({ verdict: 'malicious' });
  });

  it('answers not_found for unknown indicators', async () => {
    await expect(lookup(rep, { type: 'ipv4', value: '192.0.2.99' })).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('supports public IPs, domains, URLs and hashes, but not private IPs or hostnames', () => {
    expect(rep.supports({ type: 'ipv6', value: '2001:db8::bad' })).toBe(true);
    expect(rep.supports({ type: 'sha256', value: 'x' })).toBe(true);
    expect(rep.supports({ type: 'ipv4', value: '10.0.0.1' })).toBe(false);
    expect(rep.supports({ type: 'hostname', value: 'dc01' })).toBe(false);
    expect(rep.supports({ type: 'email', value: 'a@b.example' })).toBe(false);
  });

  it('rejects an invalid fixture at construction time', () => {
    expect(() => createReputationEnricher({}, { entries: [{ type: 'ipv4' }] })).toThrow();
  });
});

describe('geo mock', () => {
  const geo = createGeoEnricher();

  it('resolves public IPs, including Tor exits', async () => {
    await expect(lookup(geo, { type: 'ipv4', value: '198.51.100.77' })).resolves.toEqual({
      kind: 'found',
      data: {
        kind: 'geo',
        country: 'DE',
        city: 'Frankfurt',
        asn: 64502,
        org: 'Example Tor Exit Relay',
        isTor: true,
      },
    });
    await expect(lookup(geo, { type: 'ipv6', value: '2001:DB8::BAD' })).resolves.toMatchObject({
      kind: 'found',
    });
    await expect(lookup(geo, { type: 'ipv4', value: '192.0.2.99' })).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('does not support private IPs or non-IP indicators', () => {
    expect(geo.supports({ type: 'ipv4', value: '192.168.1.1' })).toBe(false);
    expect(geo.supports({ type: 'domain', value: 'evil.example' })).toBe(false);
    expect(geo.indicatorTypes).toEqual(['ipv4', 'ipv6']);
  });
});

describe('asset-inventory mock', () => {
  const assets = createAssetInventoryEnricher();

  it('resolves FQDNs, short names and internal IPs to the same asset', async () => {
    const expected = {
      kind: 'found',
      data: {
        kind: 'asset',
        hostname: 'dc01.corp.example',
        owner: 'identity-team@corp.example',
        businessUnit: 'IT Infrastructure',
        criticality: 'critical',
        tags: ['domain-controller', 'tier0'],
      },
    };
    await expect(lookup(assets, { type: 'hostname', value: 'DC01.corp.example' })).resolves.toEqual(
      expected,
    );
    await expect(lookup(assets, { type: 'hostname', value: 'dc01' })).resolves.toEqual(expected);
    await expect(lookup(assets, { type: 'ipv4', value: '10.10.0.10' })).resolves.toEqual(expected);
    await expect(lookup(assets, { type: 'ipv6', value: 'FD00::10' })).resolves.toEqual(expected);
    await expect(lookup(assets, { type: 'hostname', value: 'unknown-host' })).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('supports hostnames and internal IPs only', () => {
    expect(assets.supports({ type: 'hostname', value: 'x' })).toBe(true);
    expect(assets.supports({ type: 'ipv4', value: '10.0.0.1' })).toBe(true);
    expect(assets.supports({ type: 'ipv4', value: '203.0.113.66' })).toBe(false);
    expect(assets.supports({ type: 'domain', value: 'corp.example' })).toBe(false);
  });
});

describe('fault injection', () => {
  it('simulates latency on the injected scheduler and honours the abort signal', async () => {
    const scheduler = new VirtualScheduler();
    const rep = createReputationEnricher({ latencyMs: 200, scheduler });
    const p = rep.lookup({ type: 'domain', value: 'evil.example' }, { signal });
    await scheduler.advance(199);
    let done = false;
    void p.then(() => (done = true));
    await scheduler.advance(0);
    expect(done).toBe(false);
    await scheduler.advance(1);
    await expect(p).resolves.toMatchObject({ kind: 'found' });

    const controller = new AbortController();
    const aborted = rep.lookup(
      { type: 'domain', value: 'evil.example' },
      { signal: controller.signal },
    );
    controller.abort(new AbortedError('timeout'));
    await expect(aborted).rejects.toThrow('timeout');
  });

  it('fails a deterministic, seeded subset of calls with a transient error', async () => {
    const outcomes = async (seed: number): Promise<string[]> => {
      const geo = createGeoEnricher({ failureRate: 0.3, seed });
      const out: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        out.push(
          await lookup(geo, { type: 'ipv4', value: '198.51.100.77' }).then(
            () => 'ok',
            (e: unknown) => (e instanceof TransientProviderError ? 'fail' : 'other'),
          ),
        );
      }
      return out;
    };
    const first = await outcomes(7);
    expect(await outcomes(7)).toEqual(first);
    const failures = first.filter((o) => o === 'fail').length;
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(25);
    expect(first).not.toContain('other');
  });

  it('failureRate 1 always fails and 0 never fails', async () => {
    const always = createAssetInventoryEnricher({ failureRate: 5 });
    await expect(lookup(always, { type: 'hostname', value: 'dc01' })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    const never = createAssetInventoryEnricher({ failureRate: -1 });
    await expect(lookup(never, { type: 'hostname', value: 'dc01' })).resolves.toMatchObject({
      kind: 'found',
    });
  });

  it('createMockEnrichers builds the three providers with distinct seeds', () => {
    expect(createMockEnrichers({ seed: 3 }).map((e) => e.name)).toEqual([
      'reputation',
      'geo',
      'asset-inventory',
    ]);
  });
});
