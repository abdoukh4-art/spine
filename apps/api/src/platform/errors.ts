/**
 * Application error hierarchy. Use cases throw these; the HTTP adapter maps them to
 * RFC 9457 problem details (platform/http/problem.ts). They carry no HTTP knowledge
 * themselves beyond a stable `slug`, so they are safe to use in application code.
 */
export abstract class AppError extends Error {
  /** Stable machine-readable identifier, used as the problem `type` suffix. */
  abstract readonly slug: string;
  /** Optional field-level details. */
  readonly details: { path: string; message: string }[] | undefined;

  constructor(message: string, details?: { path: string; message: string }[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly slug = 'validation-error';
}
export class UnauthenticatedError extends AppError {
  readonly slug = 'unauthenticated';
}
export class ForbiddenError extends AppError {
  readonly slug = 'forbidden';
}
export class NotFoundError extends AppError {
  readonly slug = 'not-found';
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
  }
}
export class ConflictError extends AppError {
  readonly slug: string = 'conflict';
}
export class IdempotencyKeyReusedError extends ConflictError {
  override readonly slug = 'idempotency-key-reused';
  constructor() {
    super('This Idempotency-Key was already used with a different request body');
  }
}
export class UnprocessableError extends AppError {
  readonly slug: string = 'unprocessable';
}
export class PlaybookInvalidError extends UnprocessableError {
  override readonly slug = 'playbook-invalid';
}
export class OverloadedError extends AppError {
  readonly slug = 'overloaded';
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}
