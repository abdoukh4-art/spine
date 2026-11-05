/**
 * A tiny typed `Result` (ADR-0030). Normalizers return one instead of throwing, because bad
 * input from a sensor is an *expected* outcome, not an exceptional one: the caller must
 * handle it (count it, report the line number), and the type system makes sure it does.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Wraps a success value. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Wraps a failure value. */
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

/** Why a payload could not be turned into a canonical alert. */
export type NormalizationErrorCode =
  | 'invalid_json'
  | 'not_an_alert'
  | 'parse_error'
  | 'missing_field'
  | 'schema_violation';

/** A field-level problem, shaped like RFC 9457 `errors[]` entries. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** Typed normalization failure. `message` is safe to show to the sender. */
export interface NormalizationError {
  code: NormalizationErrorCode;
  message: string;
  issues?: FieldIssue[];
}

/** Builds a {@link NormalizationError}. */
export function normalizationError(
  code: NormalizationErrorCode,
  message: string,
  issues?: FieldIssue[],
): NormalizationError {
  return issues && issues.length > 0 ? { code, message, issues } : { code, message };
}
