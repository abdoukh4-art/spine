import { CanonicalAlertInputSchema, type CanonicalAlert } from '@spine/shared-schema';
import { err, normalizationError, ok, type NormalizationError, type Result } from '../result.js';

/** Optional context a normalizer may use. Keeps normalizers pure: no clock inside. */
export interface NormalizeContext {
  /**
   * When the payload reached Spine (ISO-8601). Used only as a last-resort `occurredAt` for
   * formats where the event time is optional (CEF without `rt`/`start`). See ADR-0031.
   */
  receivedAt?: string;
}

/** Signature shared by every normalizer (ADR-0030). */
export type Normalizer = (
  raw: unknown,
  context?: NormalizeContext,
) => Result<CanonicalAlert, NormalizationError>;

/**
 * Validates a value against the canonical schema and returns it with defaults applied.
 * Every normalizer funnels its candidate through here, so "a normalizer produced it" always
 * implies "it satisfies `CanonicalAlertInputSchema`".
 */
export function validateCanonical(candidate: unknown): Result<CanonicalAlert, NormalizationError> {
  const parsed = CanonicalAlertInputSchema.safeParse(candidate);
  if (parsed.success) return ok(parsed.data);
  return err(
    normalizationError(
      'schema_violation',
      'payload does not match the canonical alert schema',
      parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    ),
  );
}

/** Parses JSON text without throwing. Non-strings are returned as-is (already parsed). */
export function parseJsonInput(raw: unknown): Result<unknown, NormalizationError> {
  if (typeof raw !== 'string') return ok(raw);
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch {
    return err(normalizationError('invalid_json', 'payload is not valid JSON'));
  }
}

/**
 * The `canonical` normalizer: the sender already speaks Spine's schema (ADR-0011), so the
 * only job is validation. Accepts a parsed object or a JSON string (one NDJSON line).
 */
export const normalizeCanonical: Normalizer = (raw) => {
  const json = parseJsonInput(raw);
  if (!json.ok) return json;
  return validateCanonical(json.value);
};
