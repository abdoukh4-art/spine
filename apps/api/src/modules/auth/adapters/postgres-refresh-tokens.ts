import type { Db } from '../../../platform/db/database.js';
import type {
  RefreshTokenRepository,
  RefreshTokenWrite,
  RotationResult,
} from '../application/ports.js';
import { decideRefresh } from '../domain/refresh-rotation.js';

/**
 * Postgres implementation of {@link RefreshTokenRepository} (table `refresh_tokens`).
 *
 * Rotation is a read-decide-write sequence, which is a race waiting to happen: two
 * requests carrying the same token could both read "not revoked" and both rotate, giving
 * an attacker a valid parallel session. `SELECT … FOR UPDATE` takes a row lock, so the
 * second transaction blocks until the first commits and then reads the token as REVOKED,
 * which the domain rule treats as reuse (ADR-0062). The integration test
 * `auth-sessions.test.ts › concurrent refresh` proves it.
 */
export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: Db) {}

  /** Stores a new token (first of a family at login). */
  async issue(token: RefreshTokenWrite & { userId: string; familyId: string }): Promise<void> {
    await this.db
      .insertInto('refresh_tokens')
      .values({
        id: token.id,
        user_id: token.userId,
        family_id: token.familyId,
        token_hash: token.hash,
        expires_at: token.expiresAt,
      })
      .execute();
  }

  /** Atomic rotation with reuse detection; see the class comment. */
  rotate(presentedHash: Buffer, successor: RefreshTokenWrite, now: Date): Promise<RotationResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('refresh_tokens as rt')
        .innerJoin('users as u', 'u.id', 'rt.user_id')
        .select([
          'rt.id',
          'rt.user_id',
          'rt.family_id',
          'rt.revoked_at',
          'rt.expires_at',
          'u.disabled',
        ])
        .where('rt.token_hash', '=', presentedHash)
        .forUpdate('rt')
        .executeTakeFirst();
      const decision = decideRefresh(
        row
          ? { revokedAt: row.revoked_at, expiresAt: row.expires_at, userDisabled: row.disabled }
          : null,
        now,
      );
      if (decision.action === 'reject' || row === undefined) {
        return {
          outcome: 'rejected',
          reason: decision.action === 'reject' ? decision.reason : 'unknown',
        };
      }
      if (decision.action === 'revoke_family') {
        await revokeFamily(trx, row.family_id, now);
        return {
          outcome: 'family_revoked',
          reason: decision.reason,
          userId: row.user_id,
          familyId: row.family_id,
        };
      }
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: now, replaced_by: successor.id })
        .where('id', '=', row.id)
        .execute();
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: successor.id,
          user_id: row.user_id,
          family_id: row.family_id,
          token_hash: successor.hash,
          expires_at: successor.expiresAt,
        })
        .execute();
      return { outcome: 'rotated', userId: row.user_id, familyId: row.family_id };
    });
  }

  /** Logout: revoke every live token in the presented token's family. */
  async revokeFamilyOf(presentedHash: Buffer, now: Date): Promise<{ userId: string } | null> {
    const row = await this.db
      .selectFrom('refresh_tokens')
      .select(['user_id', 'family_id'])
      .where('token_hash', '=', presentedHash)
      .executeTakeFirst();
    if (!row) return null;
    await revokeFamily(this.db, row.family_id, now);
    return { userId: row.user_id };
  }

  /** Revokes all of a user's live tokens (their account was disabled). */
  async revokeAllForUser(userId: string, now: Date): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}

async function revokeFamily(db: Db, familyId: string, now: Date): Promise<void> {
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute();
}
