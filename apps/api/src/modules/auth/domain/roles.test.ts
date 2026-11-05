import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isActiveAdmin,
  isRole,
  ROLES,
  roleSatisfies,
  wouldRemoveLastActiveAdmin,
  type AdminCandidate,
} from './roles.js';

const admin = (id: string, disabled = false): AdminCandidate => ({ id, role: 'admin', disabled });

describe('role helpers', () => {
  it('recognises only the three known roles', () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(1)).toBe(false);
  });

  it('property: the hierarchy is a total order (reflexive, transitive, antisymmetric)', () => {
    const role = fc.constantFrom(...ROLES);
    fc.assert(
      fc.property(role, role, role, (a, b, c) => {
        expect(roleSatisfies(a, a)).toBe(true);
        if (roleSatisfies(a, b) && roleSatisfies(b, c)) expect(roleSatisfies(a, c)).toBe(true);
        if (roleSatisfies(a, b) && roleSatisfies(b, a)) expect(a).toBe(b);
        expect(roleSatisfies(a, b) || roleSatisfies(b, a)).toBe(true);
      }),
    );
  });

  it('counts only enabled admins as active', () => {
    expect(isActiveAdmin({ role: 'admin', disabled: false })).toBe(true);
    expect(isActiveAdmin({ role: 'admin', disabled: true })).toBe(false);
    expect(isActiveAdmin({ role: 'analyst', disabled: false })).toBe(false);
  });
});

describe('last-admin protection', () => {
  it('blocks demoting or disabling the only active admin', () => {
    expect(
      wouldRemoveLastActiveAdmin(['a'], admin('a'), { role: 'analyst', disabled: false }),
    ).toBe(true);
    expect(wouldRemoveLastActiveAdmin(['a'], admin('a'), { role: 'admin', disabled: true })).toBe(
      true,
    );
  });

  it('allows it when another active admin remains', () => {
    expect(
      wouldRemoveLastActiveAdmin(['a', 'b'], admin('a'), { role: 'viewer', disabled: false }),
    ).toBe(false);
  });

  it('ignores changes that keep the user an active admin, and changes to non-admins', () => {
    expect(wouldRemoveLastActiveAdmin(['a'], admin('a'), { role: 'admin', disabled: false })).toBe(
      false,
    );
    const analyst: AdminCandidate = { id: 'x', role: 'analyst', disabled: false };
    expect(wouldRemoveLastActiveAdmin(['a'], analyst, { role: 'viewer', disabled: true })).toBe(
      false,
    );
  });

  it('property: after an allowed change at least one active admin remains', () => {
    const user = fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd'),
      role: fc.constantFrom(...ROLES),
      disabled: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(user, { selector: (u) => u.id, minLength: 1 }),
        fc.nat(),
        fc.constantFrom(...ROLES),
        fc.boolean(),
        (users, pick, role, disabled) => {
          const active = users.filter(isActiveAdmin).map((u) => u.id);
          fc.pre(active.length > 0);
          const target = users[pick % users.length]!;
          const next = { role, disabled };
          if (wouldRemoveLastActiveAdmin(active, target, next)) return;
          const after = users.map((u) => (u.id === target.id ? { ...u, ...next } : u));
          expect(after.some(isActiveAdmin)).toBe(true);
        },
      ),
    );
  });
});
