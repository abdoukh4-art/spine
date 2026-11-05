import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toPreviewAlert } from '../../../src/modules/scoring/adapters/http.js';
import { loadRuleset, rulesetPath } from '../../../src/modules/scoring/adapters/ruleset-loader.js';
import { InvalidRulesetError } from '../../../src/modules/scoring/domain/ruleset.js';
import { createScoringModule } from '../../../src/modules/scoring/index.js';
import { as, buildTestServer, unitDeps } from '../support/module-deps.js';
import { results, testAlert } from './fixtures.js';

let server: FastifyInstance;
beforeAll(async () => {
  // Loads the real ruleset from CONFIG_DIR (apps/api/config): proves the shipped file is valid.
  const { module } = createScoringModule(unitDeps());
  server = await buildTestServer([module]);
});
afterAll(async () => {
  await server.close();
});

const ruleIds = (body: { factors: { ruleId: string }[] }) => body.factors.map((f) => f.ruleId);

const canonical = {
  source: { vendor: 'Example', product: 'Mail Gateway' },
  title: 'Credential phishing link clicked',
  category: 'phishing',
  severity: 'medium',
  occurredAt: '2026-10-28T09:00:00Z',
  url: 'http://evil.example/login',
  indicators: [{ type: 'url', value: 'http://evil.example/login' }],
};
const maliciousUrl = {
  ...results.malicious('http://evil.example/login', ['phishing']),
  indicator: { type: 'url', value: 'http://evil.example/login' },
};

describe('GET /scoring/ruleset', () => {
  it('returns the active ruleset to viewers', async () => {
    const res = await server.inject({ url: '/api/v1/scoring/ruleset', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 1, baseline: { fromSeverity: { high: 40 } } });
    expect(res.json().rules.length).toBeGreaterThanOrEqual(10);
  });

  it('requires authentication', async () => {
    expect((await server.inject({ url: '/api/v1/scoring/ruleset' })).statusCode).toBe(401);
  });
});

describe('POST /scoring/preview', () => {
  it('scores a bare canonical alert with enrichments, without storing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/scoring/preview',
      headers: as('analyst'),
      payload: { alert: canonical, enrichments: [maliciousUrl] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      score: 25 + 30 + 15,
      severity: 'high',
      rulesetVersion: 1,
      computedAt: '2026-10-28T10:00:00.000Z',
    });
    expect(ruleIds(res.json())).toEqual([
      'baseline',
      'malicious-indicator',
      'phishing-with-malicious-url',
    ]);
  });

  it('accepts a stored alert (duplicateCount is used) and defaults enrichments to []', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/scoring/preview',
      headers: as('analyst'),
      payload: { alert: testAlert({ duplicateCount: 25, mitre: [] }) },
    });
    expect(res.statusCode).toBe(200);
    expect(ruleIds(res.json())).toEqual(['baseline', 'repeated-alert']);
  });

  it('rejects viewers and invalid bodies', async () => {
    const viewer = await server.inject({
      method: 'POST',
      url: '/api/v1/scoring/preview',
      headers: as('viewer'),
      payload: { alert: canonical },
    });
    expect(viewer.statusCode).toBe(403);
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/v1/scoring/preview',
      headers: as('analyst'),
      payload: { alert: { title: 'missing fields' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().type).toBe('https://spine.dev/problems/validation-error');
  });
});

describe('toPreviewAlert', () => {
  it('fills neutral stored-alert fields for a canonical alert and keeps a stored one as is', () => {
    const stored = testAlert();
    expect(toPreviewAlert(stored, new Date())).toBe(stored);
    const {
      id: _id,
      fingerprint: _f,
      status: _s,
      receivedAt: _r,
      lastSeenAt: _l,
      duplicateCount: _d,
      ...rest
    } = stored;
    expect(toPreviewAlert(rest, new Date('2026-10-28T10:00:00Z'))).toMatchObject({
      status: 'new',
      duplicateCount: 0,
      receivedAt: '2026-10-28T10:00:00.000Z',
    });
  });
});

describe('ruleset loading fails fast (ADR-0046)', () => {
  it('refuses to create the module when the file is missing, not YAML, or invalid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spine-ruleset-'));
    await mkdir(path.join(dir, 'scoring'));
    expect(() => createScoringModule(unitDeps({ CONFIG_DIR: dir }))).toThrow(/cannot read/);

    await writeFile(path.join(dir, 'scoring/ruleset.v1.yaml'), 'rules: [unclosed');
    expect(() =>
      loadRuleset(
        rulesetPath({ CONFIG_DIR: dir, SCORING_RULESET_FILE: 'scoring/ruleset.v1.yaml' }),
      ),
    ).toThrow(/not valid YAML/);

    await writeFile(
      path.join(dir, 'scoring/ruleset.v1.yaml'),
      'version: 1\nbaseline: { fromSeverity: { informational: 0, low: 1, medium: 2, high: 3, critical: 4 } }\n' +
        "rules:\n  - { id: bad-regex, description: x, points: 1, when: { field: alert.title, op: matches, value: '(a+)+' } }\n",
    );
    expect(() => createScoringModule(unitDeps({ CONFIG_DIR: dir }))).toThrow(InvalidRulesetError);
  });
});
