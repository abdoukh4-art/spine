import type { AuditEntry, Role } from '@spine/shared-schema';
import type { Db } from '../../../platform/db/database.js';
import type { AuditRecordInput } from '../public-api.js';

/**
 * Ports of the auth module (hexagonal architecture, ADR-0002). Use cases depend on these
 * interfaces; `adapters/` implements them with argon2, jose, Postgres and Redis. Tests can
 * swap any of them for an in-memory fake.
 */

/** A user as the application sees it. Never leaves the module with its password hash. */
export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** A user plus the stored password hash; only the login use case ever sees this. */
export interface UserCredentials extends UserRecord {
  passwordHash: string;
}

/** Input for inserting a user. The password is already hashed. */
export interface NewUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  passwordHash: string;
}

/** A partial update of a user's mutable fields. */
export interface UserPatch {
  displayName?: string;
  role?: Role;
  disabled?: boolean;
}

/** Password hashing (argon2id in production). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Constant-time verification; returns false for malformed hashes instead of throwing. */
  verify(passwordHash: string, password: string): Promise<boolean>;
  /**
   * Burns the same CPU/memory as a real verification against a precomputed dummy hash,
   * so "unknown email" and "wrong password" take the same time (no user enumeration).
   */
  verifyDummy(password: string): Promise<void>;
}

/** Claims we trust after verifying an access token. */
export interface AccessClaims {
  userId: string;
  role: Role;
  tokenId: string;
}

/** Issues and verifies short-lived access tokens (JWT HS256). */
export interface AccessTokenService {
  issue(user: Pick<UserRecord, 'id' | 'role'>): Promise<{ token: string; expiresIn: number }>;
  /** @throws UnauthenticatedError for any invalid, expired, or mis-signed token. */
  verify(token: string): Promise<AccessClaims>;
}

/** Generates opaque refresh tokens and their at-rest hashes. */
export interface RefreshTokenCodec {
  /** A new random token (sent to the client) and its SHA-256 (stored). */
  generate(): { raw: string; hash: Buffer };
  hash(raw: string): Buffer;
  /** Cheap syntactic check, so garbage never reaches the database. */
  isWellFormed(raw: string): boolean;
}

/** One page of users, sorted by email. */
export interface UserPage {
  items: UserRecord[];
  nextCursor: string | null;
}

/** Persistence for users. */
export interface UserRepository {
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  findById(id: string): Promise<UserRecord | null>;
  list(query: { limit: number; cursor?: string | undefined }): Promise<UserPage>;
  /** @throws ConflictError when the email is taken. */
  create(user: NewUser): Promise<UserRecord>;
  /**
   * Applies a patch atomically, enforcing last-admin protection under row locks.
   * @throws NotFoundError, ConflictError (would leave no active admin).
   */
  update(id: string, patch: UserPatch): Promise<UserRecord>;
  recordLogin(id: string, at: Date): Promise<void>;
  /** Inserts `user` only if the table is empty (serialized by an advisory lock). */
  createFirstUser(user: NewUser): Promise<boolean>;
  /** Inserts `user` unless the email exists. Returns true when inserted. */
  createIfAbsent(user: NewUser): Promise<boolean>;
}

/** A refresh token to store (only the hash, never the raw token). */
export interface RefreshTokenWrite {
  id: string;
  hash: Buffer;
  expiresAt: Date;
}

/** Result of presenting a refresh token for rotation. */
export type RotationResult =
  | { outcome: 'rotated'; userId: string; familyId: string }
  | { outcome: 'rejected'; reason: 'unknown' | 'expired' }
  | {
      outcome: 'family_revoked';
      reason: 'reuse_detected' | 'user_disabled';
      userId: string;
      familyId: string;
    };

/** Persistence for refresh tokens; rotation is atomic (row lock + transaction). */
export interface RefreshTokenRepository {
  issue(token: RefreshTokenWrite & { userId: string; familyId: string }): Promise<void>;
  /**
   * Locks the presented token's row (`SELECT … FOR UPDATE`), applies the domain decision
   * (`decideRefresh`) and, when valid, revokes it and inserts `successor` in the same family,
   * all in ONE transaction. Concurrent calls with the same token are serialized: the
   * second one sees a revoked token.
   */
  rotate(presentedHash: Buffer, successor: RefreshTokenWrite, now: Date): Promise<RotationResult>;
  /** Revokes every live token in the family of the presented token (logout). */
  revokeFamilyOf(presentedHash: Buffer, now: Date): Promise<{ userId: string } | null>;
  /** Revokes every live token of a user (account disabled). */
  revokeAllForUser(userId: string, now: Date): Promise<void>;
}

/** A full audit row as written by this module (adds HTTP context to the public input). */
export interface AuditWrite extends AuditRecordInput {
  occurredAt: Date;
  outcomeStatus?: number;
  ip?: string;
  userAgent?: string;
}

/** Filters for reading the audit log (admin only). */
export interface AuditFilter {
  actorId?: string | undefined;
  /** Prefix match, e.g. `auth.` or `PATCH /api/v1/users`. */
  action?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** Append-only audit storage. */
export interface AuditStore {
  /** `executor` lets a caller write the entry inside its own transaction. */
  append(entry: AuditWrite, executor?: Db): Promise<void>;
  query(filter: AuditFilter): Promise<{ items: AuditEntry[]; nextCursor: string | null }>;
}

/** Fixed-window attempt counter (Redis in production, in-memory otherwise). */
export interface AttemptCounter {
  /** Records one attempt for `key` and returns the window's count including it. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }>;
}

/**
 * Keyed fingerprint of an attempted login email, for the audit log. The raw value is NOT
 * stored: people regularly type their password into the email field by mistake.
 */
export interface IdentifierFingerprinter {
  fingerprint(normalizedEmail: string): string;
}

/** Login outcomes as exported to Prometheus (`spine_auth_logins{outcome}`). */
export type LoginOutcome = 'success' | 'failure' | 'throttled';

/** Business metrics of the module (OpenTelemetry in production). */
export interface AuthMetrics {
  loginAttempt(outcome: LoginOutcome): void;
  refreshReuseDetected(): void;
}
