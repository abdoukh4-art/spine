import { AppError, ConflictError, UnauthenticatedError } from '../../../platform/errors.js';

/**
 * The ONLY error a failed login produces, whatever the cause (unknown email, wrong
 * password, disabled account): different messages would tell an attacker which emails
 * have accounts (OWASP ASVS 2.2.x / user enumeration).
 */
export class InvalidCredentialsError extends UnauthenticatedError {
  constructor() {
    super('invalid credentials');
  }
}

/** The presented refresh cookie can't be used (missing, unknown, expired or revoked). */
export class InvalidRefreshTokenError extends UnauthenticatedError {
  constructor() {
    super('invalid refresh token');
  }
}

/** Login throttled (per-IP or per-username window exceeded). Maps to 429 + Retry-After. */
export class TooManyAttemptsError extends AppError {
  readonly slug = 'rate-limited';
  constructor(readonly retryAfterSeconds: number) {
    super('too many login attempts, try again later');
  }
}

/** A change would leave the system without an active admin (ADR-0065). */
export class LastActiveAdminError extends ConflictError {
  constructor() {
    super('this change would leave no active admin');
  }
}
