import { ROLES, roleSatisfies, type Role } from '@spine/shared-schema';

/**
 * Role hierarchy helpers (ADR-0017). The hierarchy itself (`viewer < analyst < admin`)
 * and `roleSatisfies` live in `@spine/shared-schema`, so the console and the API agree.
 */
export { ROLES, roleSatisfies, type Role };

/** True if `value` is one of the known roles (used when decoding untrusted token claims). */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** The minimal facts about an account needed to reason about admin coverage. */
export interface AdminCandidate {
  id: string;
  role: Role;
  disabled: boolean;
}

/** An account counts as an "active admin" when it has the admin role and is not disabled. */
export function isActiveAdmin(user: Pick<AdminCandidate, 'role' | 'disabled'>): boolean {
  return user.role === 'admin' && !user.disabled;
}

/**
 * Last-admin protection (ADR-0065): would applying `next` to `current` leave the system
 * with zero active admins? `activeAdminIds` is the set of active admins BEFORE the change.
 * Without this rule, an admin could lock everyone out of user management for good.
 */
export function wouldRemoveLastActiveAdmin(
  activeAdminIds: readonly string[],
  current: AdminCandidate,
  next: Pick<AdminCandidate, 'role' | 'disabled'>,
): boolean {
  if (!isActiveAdmin(current) || isActiveAdmin(next)) return false;
  const remaining = activeAdminIds.filter((id) => id !== current.id);
  return remaining.length === 0;
}
