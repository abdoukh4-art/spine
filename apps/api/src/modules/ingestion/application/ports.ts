import type { IngestResult } from '@spine/shared-schema';
import type { DbExecutor } from '../../../platform/events/types.js';

/** Secondary ports of the Ingestion module (ADR-0002). */

/** Runs a function inside one database transaction. */
export interface TransactionRunner {
  run<T>(fn: (trx: DbExecutor) => Promise<T>): Promise<T>;
}

/** A stored idempotent response (ADR-0012). */
export interface StoredResponse {
  requestHash: Buffer;
  status: number;
  body: IngestResult;
}

/** Persistence of `idempotency_keys`. */
export interface IdempotencyStore {
  /** The live (not expired) record for `(scope, key)`, if any. */
  find(
    trx: DbExecutor,
    scope: string,
    key: string,
    notBefore: Date,
  ): Promise<StoredResponse | null>;
  /**
   * Inserts the record, overwriting an *expired* one. Returns false when a live record for the
   * same key exists (a concurrent request won the race), so the caller can retry and replay.
   */
  save(
    trx: DbExecutor,
    record: { scope: string; key: string; response: StoredResponse; createdAt: Date },
    expiredBefore: Date,
  ): Promise<boolean>;
  /** Deletes expired records; returns how many. */
  deleteExpired(expiredBefore: Date): Promise<number>;
}

/** Reports how many outbox events wait for dispatch (ADR-0024 back-pressure). */
export type BacklogProbe = () => Promise<number>;
