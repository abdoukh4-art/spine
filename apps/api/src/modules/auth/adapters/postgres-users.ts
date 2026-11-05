import { sql, type Selectable } from 'kysely';
import type { Db } from '../../../platform/db/database.js';
import type { UsersTable } from '../../../platform/db/schema.js';
import { ConflictError, NotFoundError } from '../../../platform/errors.js';
import { decodeCursor, paginate } from '../../../platform/http/pagination.js';
import { LastActiveAdminError } from '../application/errors.js';
import type {
  NewUser,
  UserCredentials,
  UserPage,
  UserPatch,
  UserRecord,
  UserRepository,
} from '../application/ports.js';
import { wouldRemoveLastActiveAdmin } from '../domain/roles.js';

const UNIQUE_VIOLATION = '23505';
/** Arbitrary but fixed key for `pg_advisory_xact_lock` (serializes first-user bootstrap). */
const BOOTSTRAP_LOCK_KEY = 0x5_1e_00_01;

type UserRow = Selectable<UsersTable>;

function toCredentials(row: UserRow): UserCredentials {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    passwordHash: row.password_hash,
  };
}

/** Maps a row to a record WITHOUT the password hash (the column is not even selected). */
function toRecord(row: Omit<UserRow, 'password_hash'>): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const PUBLIC_COLUMNS = [
  'id',
  'email',
  'display_name',
  'role',
  'disabled',
  'created_at',
  'last_login_at',
] as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION;
}

/** Postgres implementation of {@link UserRepository} (table `users`, email is `citext`). */
export class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  /** Looks up by email; `citext` makes the comparison case-insensitive. */
  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
    return row ? toCredentials(row) : null;
  }

  /** Looks up by id (the authenticator's hot path; primary-key lookup). */
  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom('users')
      .select(PUBLIC_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /** Keyset pagination on `(email, id)`: stable while users are added. */
  async list(query: { limit: number; cursor?: string | undefined }): Promise<UserPage> {
    let q = this.db
      .selectFrom('users')
      .select(PUBLIC_COLUMNS)
      .orderBy('email')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      const email = String(cursor.k);
      q = q.where((eb) =>
        eb.or([
          eb('email', '>', email),
          eb.and([eb('email', '=', email), eb('id', '>', cursor.id)]),
        ]),
      );
    }
    const rows = await q.execute();
    const page = paginate(rows, query.limit, (r) => ({ k: r.email, id: r.id }));
    return { items: page.items.map(toRecord), nextCursor: page.nextCursor };
  }

  /** @throws ConflictError when the email already exists (case-insensitively). */
  async create(user: NewUser): Promise<UserRecord> {
    try {
      const row = await this.db
        .insertInto('users')
        .values(toInsert(user))
        .returning(PUBLIC_COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('a user with this email already exists');
      throw err;
    }
  }

  /**
   * Last-admin protection under concurrency: lock every active admin row FIRST (in a fixed
   * order), then the target. Two admins demoting each other at the same time are
   * serialized, and the second one sees that only one admin is left.
   */
  update(id: string, patch: UserPatch): Promise<UserRecord> {
    return this.db.transaction().execute(async (trx) => {
      const admins = await trx
        .selectFrom('users')
        .select('id')
        .where('role', '=', 'admin')
        .where('disabled', '=', false)
        .orderBy('id')
        .forUpdate()
        .execute();
      const current = await trx
        .selectFrom('users')
        .select(['id', 'role', 'disabled'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('User', id);
      const next = {
        role: patch.role ?? current.role,
        disabled: patch.disabled ?? current.disabled,
      };
      if (
        wouldRemoveLastActiveAdmin(
          admins.map((a) => a.id),
          current,
          next,
        )
      ) {
        throw new LastActiveAdminError();
      }
      const row = await trx
        .updateTable('users')
        .set({
          ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
          role: next.role,
          disabled: next.disabled,
        })
        .where('id', '=', id)
        .returning(PUBLIC_COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  /** Stamps `last_login_at`. */
  async recordLogin(id: string, at: Date): Promise<void> {
    await this.db.updateTable('users').set({ last_login_at: at }).where('id', '=', id).execute();
  }

  /**
   * "Insert if the table is empty" is a check-then-act race between two API replicas
   * starting together. A transaction-scoped advisory lock makes it atomic.
   */
  createFirstUser(user: NewUser): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`.execute(trx);
      const existing = await trx.selectFrom('users').select('id').limit(1).executeTakeFirst();
      if (existing) return false;
      await trx.insertInto('users').values(toInsert(user)).execute();
      return true;
    });
  }

  /** `INSERT … ON CONFLICT (email) DO NOTHING`: idempotent seeding. */
  async createIfAbsent(user: NewUser): Promise<boolean> {
    const result = await this.db
      .insertInto('users')
      .values(toInsert(user))
      .onConflict((oc) => oc.column('email').doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }
}

function toInsert(user: NewUser) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    password_hash: user.passwordHash,
  };
}
