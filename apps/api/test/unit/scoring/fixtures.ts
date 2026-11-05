import type { Alert, EnrichmentResult, Ruleset } from '@spine/shared-schema';

/** A realistic alert used across scoring tests. Override fields as needed. */
export function testAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: '00000000-0000-7000-8000-0000000000a1',
    fingerprint: 'a'.repeat(64),
    status: 'new',
    source: { vendor: 'Example EDR', product: 'Sensor' },
    title: 'Suspicious LSASS access',
    category: 'credential_access',
    severity: 'high',
    occurredAt: '2026-10-28T09:58:00.000Z',
    receivedAt: '2026-10-28T10:00:00.000Z',
    lastSeenAt: '2026-10-28T10:00:00.000Z',
    duplicateCount: 0,
    host: { hostname: 'dc01.corp.example', ips: ['10.10.0.10'] },
    indicators: [{ type: 'ipv4', value: '203.0.113.66' }],
    mitre: [{ tacticId: 'TA0006', techniqueId: 'T1003.001' }],
    labels: {},
    ...overrides,
  };
}

const fetchedAt = '2026-10-28T10:00:01.000Z';

/** Builders for enrichment results. */
export const results = {
  malicious(value = '203.0.113.66', tags: string[] = ['c2']): EnrichmentResult {
    return {
      provider: 'reputation',
      indicator: { type: 'ipv4', value },
      status: 'ok',
      verdict: 'malicious',
      data: { kind: 'reputation', score: 96, verdict: 'malicious', tags },
      durationMs: 12,
      fetchedAt,
    };
  },
  suspicious(value = '198.51.100.23', tags: string[] = ['scanner']): EnrichmentResult {
    return {
      provider: 'reputation',
      indicator: { type: 'ipv4', value },
      status: 'ok',
      verdict: 'suspicious',
      data: { kind: 'reputation', score: 48, verdict: 'suspicious', tags },
      durationMs: 12,
      fetchedAt,
    };
  },
  asset(
    criticality: 'low' | 'medium' | 'high' | 'critical',
    tags: string[] = [],
  ): EnrichmentResult {
    return {
      provider: 'asset-inventory',
      indicator: { type: 'hostname', value: `host-${criticality}.corp.example` },
      status: 'ok',
      data: {
        kind: 'asset',
        hostname: `host-${criticality}.corp.example`,
        owner: 'it@corp.example',
        criticality,
        tags,
      },
      durationMs: 3,
      fetchedAt,
    };
  },
  geo(ip: string, country: string, isTor: boolean): EnrichmentResult {
    return {
      provider: 'geo',
      indicator: { type: 'ipv4', value: ip },
      status: 'ok',
      data: { kind: 'geo', country, asn: 64500, isTor },
      durationMs: 5,
      fetchedAt,
    };
  },
  failed(
    provider: string,
    status: 'timeout' | 'error' | 'circuit_open' | 'rejected',
  ): EnrichmentResult {
    return {
      provider,
      indicator: { type: 'ipv4', value: '203.0.113.66' },
      status,
      error: 'simulated',
      durationMs: 1000,
      fetchedAt,
    };
  },
};

/** A small ruleset for engine tests (the real one is tested separately). */
export const smallRuleset: Ruleset = {
  version: 7,
  baseline: { fromSeverity: { informational: 0, low: 10, medium: 25, high: 40, critical: 55 } },
  rules: [
    {
      id: 'malicious-indicator',
      description: 'Malicious indicator',
      when: { field: 'enrichment.verdicts', op: 'contains', value: 'malicious' },
      points: 30,
      evidenceField: 'enrichment.maliciousIndicators',
    },
    {
      id: 'critical-asset',
      description: 'Critical asset',
      when: { field: 'enrichment.asset.criticality', op: 'eq', value: 'critical' },
      points: 20,
    },
    {
      id: 'scanner',
      description: 'Authorized scanner',
      when: { field: 'enrichment.reputationTags', op: 'contains', value: 'authorized-scanner' },
      points: -60,
    },
  ],
};
