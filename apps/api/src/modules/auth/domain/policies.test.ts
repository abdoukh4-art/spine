import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeHttpAction, isMutatingMethod } from './audit-policy.js';
import { checkCsrf } from './csrf-policy.js';

describe('audit policy', () => {
  it('audits mutating methods only', () => {
    for (const m of ['POST', 'put', 'PATCH', 'DELETE']) expect(isMutatingMethod(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isMutatingMethod(m)).toBe(false);
  });

  it('describes a route by its pattern and takes the target from the first path param', () => {
    expect(
      describeHttpAction('patch', '/api/v1/users/:id', {
        id: '0190a0a0-0000-7000-8000-000000000001',
      }),
    ).toEqual({
      action: 'PATCH /api/v1/users/:id',
      targetType: 'users',
      targetId: '0190a0a0-0000-7000-8000-000000000001',
    });
    expect(
      describeHttpAction('POST', '/api/v1/ingest/webhooks/:sourceId', { sourceId: 'suricata' }),
    ).toMatchObject({ targetType: 'webhooks', targetId: 'suricata' });
  });

  it('has no target when the route has no params or the param is missing', () => {
    expect(describeHttpAction('POST', '/api/v1/auth/login', {})).toEqual({
      action: 'POST /api/v1/auth/login',
      targetType: null,
      targetId: null,
    });
    expect(describeHttpAction('POST', '/:id', {})).toEqual({
      action: 'POST /:id',
      targetType: null,
      targetId: null,
    });
  });

  it('property: target ids are bounded to 200 characters', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 1000 }), (id) => {
        const { targetId } = describeHttpAction('DELETE', '/x/:id', { id });
        expect(targetId?.length).toBeLessThanOrEqual(200);
      }),
    );
  });
});

describe('CSRF policy', () => {
  const allowed = ['https://spine.test', 'http://localhost:5173'];

  it('accepts the custom header with an allowed origin', () => {
    expect(checkCsrf({ csrfHeader: '1', origin: 'https://spine.test' }, allowed)).toEqual({
      ok: true,
    });
  });

  it('rejects a missing or wrong custom header', () => {
    expect(checkCsrf({ csrfHeader: undefined, origin: 'https://spine.test' }, allowed)).toEqual({
      ok: false,
      reason: 'missing_csrf_header',
    });
    expect(checkCsrf({ csrfHeader: 'true', origin: 'https://spine.test' }, allowed)).toMatchObject({
      ok: false,
    });
  });

  it('rejects a missing origin in every environment', () => {
    expect(checkCsrf({ csrfHeader: '1', origin: undefined }, allowed)).toEqual({
      ok: false,
      reason: 'missing_origin',
    });
    expect(checkCsrf({ csrfHeader: '1', origin: '' }, allowed)).toMatchObject({ ok: false });
  });

  it('rejects unlisted, look-alike and null origins', () => {
    for (const origin of ['https://evil.example', 'https://spine.test.evil.example', 'null']) {
      expect(checkCsrf({ csrfHeader: '1', origin }, allowed)).toEqual({
        ok: false,
        reason: 'origin_not_allowed',
      });
    }
  });
});
