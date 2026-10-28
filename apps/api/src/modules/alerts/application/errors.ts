import { ConflictError } from '../../../platform/errors.js';

/**
 * Raised when a write would create a second OPEN alert with the same fingerprint, i.e. the
 * partial unique index `alerts_open_fingerprint_uq` rejected it (ADR-0012).
 *
 * - Ingestion catches it and retries the occurrence as a duplicate (the race was lost).
 * - A reopen that hits it surfaces as HTTP 409: someone must work on the newer open alert.
 */
export class OpenAlertExistsError extends ConflictError {
  constructor(readonly fingerprint: string) {
    super('another open alert with the same fingerprint already exists');
  }
}
