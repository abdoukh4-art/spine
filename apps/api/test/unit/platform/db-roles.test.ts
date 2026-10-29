import { describe, expect, it } from 'vitest';
import { credentialsFromUrl, isPrivileged } from '../../../src/platform/db/roles.js';

describe('credentialsFromUrl', () => {
  it('decodes percent-encoded user names and passwords', () => {
    expect(credentialsFromUrl('postgres://spine_app:p%40ss%3Aw0rd@db:5432/spine')).toEqual({
      user: 'spine_app',
      password: 'p@ss:w0rd',
    });
  });

  it('returns an empty password when the URL has none', () => {
    expect(credentialsFromUrl('postgres://spine@db/spine').password).toBe('');
  });
});

describe('isPrivileged', () => {
  const leastPrivilege = {
    role: 'spine_app',
    superuser: false,
    ownsAuditLog: false,
    canRewriteAuditLog: false,
  };

  it('accepts a role that can only append to the audit log', () => {
    expect(isPrivileged(leastPrivilege)).toBe(false);
  });

  it.each([
    ['a superuser', { superuser: true }],
    ['the audit log owner', { ownsAuditLog: true }],
    ['a role with UPDATE/DELETE on the audit log', { canRewriteAuditLog: true }],
  ])('flags %s', (_name, override) => {
    expect(isPrivileged({ ...leastPrivilege, ...override })).toBe(true);
  });
});
