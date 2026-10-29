import type { CreateUserRequest, UpdateUserRequest } from '@spine/shared-schema';
import { NotFoundError, ValidationError } from '../../../platform/errors.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import { normalizeEmail } from '../domain/login-throttle.js';
import { checkPasswordPolicy } from '../domain/password-policy.js';
import type {
  PasswordHasher,
  RefreshTokenRepository,
  UserPage,
  UserPatch,
  UserRecord,
  UserRepository,
} from './ports.js';

/** Dependencies of {@link UserAdminService}. */
export interface UserAdminDeps {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  hasher: PasswordHasher;
  clock: Clock;
  ids: IdGenerator;
  /** Called after a user changes, so cached principals are dropped immediately. */
  onUserChanged: (userId: string) => void;
}

/**
 * User management use cases (admin only; RBAC is enforced at the route). Invariants:
 * emails are unique (case-insensitively), passwords meet the policy, and the system always
 * keeps at least one active admin (ADR-0065).
 */
export class UserAdminService {
  constructor(private readonly deps: UserAdminDeps) {}

  /** Returns the current user (for `GET /auth/me`). */
  async me(userId: string): Promise<UserRecord> {
    const user = await this.deps.users.findById(userId);
    if (user === null) throw new NotFoundError('User', userId);
    return user;
  }

  /** Lists users sorted by email, keyset-paginated. */
  list(query: { limit: number; cursor?: string | undefined }): Promise<UserPage> {
    return this.deps.users.list(query);
  }

  /** Creates a user. @throws ValidationError (password policy), ConflictError (email taken). */
  async create(input: CreateUserRequest): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    assertPasswordPolicy(input.password, email);
    return this.deps.users.create({
      id: this.deps.ids.next(),
      email,
      displayName: input.displayName,
      role: input.role,
      passwordHash: await this.deps.hasher.hash(input.password),
    });
  }

  /**
   * Updates role / disabled / display name. Disabling a user also revokes all their refresh
   * tokens, so they can't mint new access tokens; existing access tokens stop working at the
   * authenticator's next user lookup (ADR-0060).
   */
  async update(id: string, input: UpdateUserRequest): Promise<UserRecord> {
    const patch: UserPatch = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    };
    const updated = await this.deps.users.update(id, patch);
    if (updated.disabled) {
      await this.deps.refreshTokens.revokeAllForUser(id, this.deps.clock.now());
    }
    this.deps.onUserChanged(id);
    return updated;
  }
}

/** @throws ValidationError listing every policy violation under `body.password`. */
export function assertPasswordPolicy(password: string, email: string): void {
  const violations = checkPasswordPolicy(password, { email });
  if (violations.length > 0) {
    throw new ValidationError(
      'password does not meet the policy',
      violations.map((v) => ({ path: 'body.password', message: v.message })),
    );
  }
}
