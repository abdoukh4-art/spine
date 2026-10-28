import { UnauthenticatedError } from '../../../platform/errors.js';
import type { Authenticator, Principal } from '../../../platform/http/access.js';
import type { Clock } from '../../../platform/runtime.js';
import type { AccessTokenService, UserRecord, UserRepository } from './ports.js';

/** Options for {@link UserAuthenticator}. */
export interface UserAuthenticatorOptions {
  accessTokens: AccessTokenService;
  users: UserRepository;
  clock: Clock;
  /** How long a loaded user may be reused (ADR-0060). 0 disables the cache. */
  cacheTtlMs: number;
  /** Upper bound on cached users, so memory can't grow without limit. */
  maxEntries?: number;
}

interface CacheEntry {
  user: UserRecord;
  expiresAt: number;
}

/**
 * The platform's {@link Authenticator} port (ADR-0060): verifies the JWT, then loads the
 * user so a disabled account or a role change takes effect within `cacheTtlMs`, instead of
 * only when the 15-minute access token expires. The role in the principal is the one from
 * the DATABASE, not the (possibly stale) one in the token.
 */
export class UserAuthenticator implements Authenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(private readonly options: UserAuthenticatorOptions) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** @throws UnauthenticatedError for bad tokens and for missing or disabled users. */
  async authenticate(bearerToken: string): Promise<Extract<Principal, { kind: 'user' }>> {
    const claims = await this.options.accessTokens.verify(bearerToken);
    const user = await this.loadUser(claims.userId);
    if (user === null || user.disabled) {
      // Same message as a bad token: callers learn nothing about the account's state.
      throw new UnauthenticatedError('invalid or expired token');
    }
    return { kind: 'user', id: user.id, role: user.role, email: user.email };
  }

  /** Drops a cached user immediately (called after this process changes the user). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async loadUser(id: string): Promise<UserRecord | null> {
    const now = this.options.clock.now().getTime();
    const hit = this.cache.get(id);
    if (hit !== undefined && hit.expiresAt > now) return hit.user;
    const user = await this.options.users.findById(id);
    if (user === null || this.options.cacheTtlMs <= 0) return user;
    if (this.cache.size >= this.maxEntries) {
      // Map iterates in insertion order: evict the oldest entry (cheap FIFO).
      const oldest = this.cache.keys().next();
      if (oldest.done !== true) this.cache.delete(oldest.value);
    }
    this.cache.set(id, { user, expiresAt: now + this.options.cacheTtlMs });
    return user;
  }
}
