import type { RunSnapshot } from '@spine/playbook-engine';
import type { Alert, EnrichmentResult, ScoreExplanation } from '@spine/shared-schema';

/** Synthetic but realistic test data for the playbooks module. */
export function alertFixture(overrides: Partial<Alert> = {}): Alert {
  return {
    id: '0190f0a0-0000-7000-8000-000000000001',
    fingerprint: 'a'.repeat(64),
    status: 'new',
    source: { vendor: 'Acme', product: 'EDR' },
    title: 'Emotet loader executed',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-10-28T09:00:00.000Z',
    receivedAt: '2026-10-28T09:00:01.000Z',
    lastSeenAt: '2026-10-28T09:00:01.000Z',
    duplicateCount: 0,
    host: { hostname: 'FIN-WS-042', ips: ['10.0.4.42'] },
    user: { name: 'dana', email: 'dana@example.com' },
    network: { sourceIp: '203.0.113.7', destinationIp: '10.0.4.42' },
    indicators: [
      { type: 'ipv4', value: '203.0.113.7' },
      { type: 'domain', value: 'evil.example' },
      { type: 'ipv4', value: '198.51.100.20' },
    ],
    mitre: [{ techniqueId: 'T1204' }],
    labels: {},
    ...overrides,
  };
}

export function enrichmentFixture(
  value: string,
  type: EnrichmentResult['indicator']['type'],
  verdict: EnrichmentResult['verdict'],
  provider = 'mock-reputation',
): EnrichmentResult {
  return {
    provider,
    indicator: { type, value },
    status: 'ok',
    ...(verdict ? { verdict } : {}),
    durationMs: 12,
    fetchedAt: '2026-10-28T09:00:02.000Z',
  };
}

export function scoreFixture(score: number): ScoreExplanation {
  return {
    score,
    rawScore: score,
    severity: score >= 80 ? 'critical' : score >= 60 ? 'high' : 'medium',
    rulesetVersion: 1,
    factors: [{ ruleId: 'baseline', description: 'severity baseline', points: score }],
    dataGaps: [],
    computedAt: '2026-10-28T09:00:03.000Z',
  };
}

export function snapshotFixture(
  options: {
    alert?: Partial<Alert>;
    score?: number;
    enrichments?: EnrichmentResult[];
  } = {},
): RunSnapshot {
  return {
    alert: alertFixture(options.alert),
    score: scoreFixture(options.score ?? 90),
    enrichments: options.enrichments ?? [
      enrichmentFixture('203.0.113.7', 'ipv4', 'malicious'),
      enrichmentFixture('evil.example', 'domain', 'suspicious'),
      enrichmentFixture('198.51.100.20', 'ipv4', 'benign'),
    ],
  };
}
