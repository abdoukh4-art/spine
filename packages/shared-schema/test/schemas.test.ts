import { describe, expect, it } from 'vitest';
import {
  AlertListQuerySchema,
  CanonicalAlertInputSchema,
  EVENT_TYPES,
  PlaybookDefinitionSchema,
  RulesetSchema,
  isAllowedAlertTransition,
  parseEventPayload,
  roleSatisfies,
  severityFromScore,
  severityRank,
} from '../src/index.js';

const validAlert = {
  source: { vendor: 'Acme', product: 'EDR', sourceAlertId: 'A-1' },
  title: 'Suspicious PowerShell',
  category: 'intrusion',
  occurredAt: '2026-10-28T10:00:00Z',
  host: { hostname: 'ws-1', ips: ['10.0.0.5'] },
  indicators: [{ type: 'ipv4', value: '203.0.113.7' }],
  mitre: [{ tacticId: 'TA0002', techniqueId: 'T1059.001' }],
};

describe('CanonicalAlertInputSchema', () => {
  it('accepts a valid alert and applies defaults', () => {
    const parsed = CanonicalAlertInputSchema.parse(validAlert);
    expect(parsed.severity).toBe('medium');
    expect(parsed.labels).toEqual({});
  });
  it('rejects malformed MITRE ids, IPs and categories', () => {
    expect(
      CanonicalAlertInputSchema.safeParse({ ...validAlert, mitre: [{ techniqueId: 'X1' }] })
        .success,
    ).toBe(false);
    expect(
      CanonicalAlertInputSchema.safeParse({ ...validAlert, host: { ips: ['999.1.1.1'] } }).success,
    ).toBe(false);
    expect(CanonicalAlertInputSchema.safeParse({ ...validAlert, category: 'weird' }).success).toBe(
      false,
    );
  });
  it('rejects timestamps without timezone', () => {
    expect(
      CanonicalAlertInputSchema.safeParse({ ...validAlert, occurredAt: '2026-10-28 10:00' })
        .success,
    ).toBe(false);
  });
});

describe('status transitions', () => {
  it('allows the documented lifecycle and reopen', () => {
    expect(isAllowedAlertTransition('new', 'triaged')).toBe(true);
    expect(isAllowedAlertTransition('resolved', 'in_progress')).toBe(true);
  });
  it('forbids nonsense transitions', () => {
    expect(isAllowedAlertTransition('resolved', 'new')).toBe(false);
    expect(isAllowedAlertTransition('new', 'new')).toBe(false);
  });
});

describe('helpers', () => {
  it('maps scores to severity bands at the boundaries', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(severityFromScore)).toEqual([
      'informational',
      'informational',
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });
  it('orders severities and roles', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('low'));
    expect(roleSatisfies('admin', 'analyst')).toBe(true);
    expect(roleSatisfies('viewer', 'analyst')).toBe(false);
  });
});

describe('AlertListQuerySchema', () => {
  it('normalizes single and repeated enum params to arrays and coerces numbers', () => {
    const q = AlertListQuerySchema.parse({
      status: 'new',
      severity: ['high', 'critical'],
      minScore: '50',
    });
    expect(q.status).toEqual(['new']);
    expect(q.severity).toEqual(['high', 'critical']);
    expect(q.minScore).toBe(50);
    expect(q.limit).toBe(50);
  });
});

describe('PlaybookDefinitionSchema', () => {
  it('accepts a minimal playbook and applies step defaults', () => {
    const pb = PlaybookDefinitionSchema.parse({
      apiVersion: 'spine/v1',
      kind: 'Playbook',
      metadata: { id: 'notify-only', name: 'Notify', version: 1 },
      start: 'n',
      steps: [{ id: 'n', type: 'notify', with: { channel: '#soc', template: 'hi' } }],
    });
    expect(pb.steps[0]?.timeoutMs).toBe(30_000);
    expect(pb.steps[0]?.onFailure).toBe('fail');
  });
  it('rejects unknown step types and unknown keys', () => {
    const base = {
      apiVersion: 'spine/v1',
      kind: 'Playbook',
      metadata: { id: 'x', name: 'x', version: 1 },
      start: 'a',
    };
    expect(
      PlaybookDefinitionSchema.safeParse({ ...base, steps: [{ id: 'a', type: 'shell', with: {} }] })
        .success,
    ).toBe(false);
    expect(
      PlaybookDefinitionSchema.safeParse({
        ...base,
        steps: [{ id: 'a', type: 'score', with: {}, script: 'rm -rf /' }],
      }).success,
    ).toBe(false);
  });
});

describe('RulesetSchema', () => {
  it('requires a baseline for every severity', () => {
    expect(
      RulesetSchema.safeParse({ version: 1, baseline: { fromSeverity: { low: 1 } }, rules: [] })
        .success,
    ).toBe(false);
  });
});

describe('event catalog', () => {
  it('lists every event type and validates payloads', () => {
    expect(EVENT_TYPES).toContain('alert.scored');
    expect(() => parseEventPayload('alert.deduplicated', { alertId: 'nope' })).toThrow();
  });
});
