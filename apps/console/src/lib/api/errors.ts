import type { Problem } from '@spine/shared-schema';
import { PROBLEM_TYPE_BASE } from '@spine/shared-schema';

/** One field-level error from an RFC 9457 problem's `errors[]` member. */
export interface FieldError {
  path: string;
  message: string;
}

/**
 * An HTTP error returned by the API, parsed from an RFC 9457 problem document (ADR-0024).
 * `type` is the short slug (`conflict`, `validation-error`, …), not the full URI, so UI
 * code can switch on it without string-munging.
 */
export class ApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Problem slug, e.g. `conflict`. `unknown` when the body was not a problem document. */
  readonly type: string;
  /** Short human-readable summary from the server. */
  readonly title: string;
  /** Longer explanation, when the server provided one. */
  readonly detail: string | undefined;
  /** Request ID for log lookup (the problem's `instance`). */
  readonly instance: string | undefined;
  /** Field-level validation errors (empty when none). */
  readonly errors: readonly FieldError[];

  /** Builds an ApiError from a parsed problem document. */
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.type = problemSlug(problem.type);
    this.title = problem.title;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.errors = problem.errors ?? [];
  }
}

/**
 * Thrown when a response body does not match the shared Zod schema: the backend and the
 * console disagree about the contract (ADR-0005). This is a bug, never a user error.
 */
export class ContractError extends Error {
  /** `METHOD /path` of the request whose response failed validation. */
  readonly endpoint: string;
  /** Human-readable list of mismatches (`path: message`). */
  readonly issues: readonly string[];

  /** Builds a contract error for one endpoint and its list of schema issues. */
  constructor(endpoint: string, issues: readonly string[]) {
    super(`Contract mismatch in response of ${endpoint}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ContractError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

/** Thrown when the request never got an HTTP response (offline, DNS, CORS). */
export class NetworkError extends Error {
  /** Wraps the underlying fetch failure. */
  constructor(cause: unknown) {
    super('The server could not be reached. Check your connection and try again.', { cause });
    this.name = 'NetworkError';
  }
}

/** Reduces a problem `type` URI to its slug (`https://spine.dev/problems/conflict` → `conflict`). */
export function problemSlug(type: string): string {
  if (type.startsWith(PROBLEM_TYPE_BASE)) return type.slice(PROBLEM_TYPE_BASE.length);
  const lastSegment = type.split('/').pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : 'unknown';
}

/** True if `error` is an ApiError, optionally with the given HTTP status. */
export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

/** A message safe to show to a user for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? error.title;
  if (error instanceof ContractError) {
    return 'The server sent data the console does not understand. Please report this.';
  }
  if (error instanceof NetworkError) return error.message;
  return 'Something went wrong.';
}
