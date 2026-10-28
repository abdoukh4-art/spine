import type { Role } from '@spine/shared-schema';
import type { Logger } from '../../../platform/logger.js';
import type { IdGenerator } from '../../../platform/runtime.js';
import { normalizeEmail } from '../domain/login-throttle.js';
import { assertPasswordPolicy } from './users.js';
import type { PasswordHasher, UserRepository } from './ports.js';

/** A user to create at startup or when seeding demo data. */
export interface SeedUser {
  email: string;
  displayName: string;
  role: Role;
  password: string;
}

/** Dependencies of the bootstrap / seeding use cases. */
export interface BootstrapDeps {
  users: UserRepository;
  hasher: PasswordHasher;
  ids: IdGenerator;
  logger: Logger;
}

/**
 * First-run bootstrap (ADR-0066): when the users table is EMPTY and both
 * `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set, create that admin.
 * Once any user exists this is a no-op, so rotating the env var later can't create a
 * backdoor admin. The password is never logged.
 */
export async function bootstrapAdmin(
  deps: BootstrapDeps,
  email: string | undefined,
  password: string | undefined,
): Promise<'created' | 'skipped'> {
  if (email === undefined || password === undefined) return 'skipped';
  const normalized = normalizeEmail(email);
  assertPasswordPolicy(password, normalized);
  const created = await deps.users.createFirstUser({
    id: deps.ids.next(),
    email: normalized,
    displayName: 'Bootstrap admin',
    role: 'admin',
    passwordHash: await deps.hasher.hash(password),
  });
  if (created) deps.logger.info({ email: normalized }, 'bootstrap admin created');
  return created ? 'created' : 'skipped';
}

/**
 * Idempotent seeding helper for demos and tests (e.g. `analyst@spine.test`): creates each
 * user unless its email already exists. Returns the emails actually created.
 */
export async function seedUsers(
  deps: BootstrapDeps,
  users: readonly SeedUser[],
): Promise<string[]> {
  const created: string[] = [];
  for (const user of users) {
    const email = normalizeEmail(user.email);
    assertPasswordPolicy(user.password, email);
    const inserted = await deps.users.createIfAbsent({
      id: deps.ids.next(),
      email,
      displayName: user.displayName,
      role: user.role,
      passwordHash: await deps.hasher.hash(user.password),
    });
    if (inserted) created.push(email);
  }
  if (created.length > 0) deps.logger.info({ emails: created }, 'seeded users');
  return created;
}
