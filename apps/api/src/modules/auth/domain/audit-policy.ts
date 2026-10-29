/**
 * What the automatic HTTP audit trail records (ADR-0016, ADR-0064; OWASP A09).
 *
 * Every state-changing request is recorded; reads are not (they would drown the signal,
 * and RBAC already restricts them). The entry describes WHO did WHAT to WHICH resource
 * and HOW it ended. It never contains request or response bodies: bodies carry passwords,
 * tokens and alert payloads that don't belong in a long-lived, widely-readable log.
 */

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True for methods that change state and must be audited. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** The action/target part of an HTTP audit entry. */
export interface HttpAuditDescription {
  /** `METHOD routePattern`, e.g. `PATCH /api/v1/users/:id` (the pattern, not the raw URL). */
  action: string;
  targetType: string | null;
  targetId: string | null;
}

/** Longest target id we keep: route params are validated elsewhere, but be defensive. */
const MAX_TARGET_ID_LENGTH = 200;

/**
 * Derives action and target from the matched route. Using the route PATTERN (not the
 * concrete URL) keeps actions groupable (`PATCH /api/v1/users/:id`) and keeps query strings
 * (which might contain secrets) out of the log. The target is the first path parameter,
 * and its type is the path segment just before it (`/users/:id` → `users`).
 */
export function describeHttpAction(
  method: string,
  routeUrl: string,
  params: Readonly<Record<string, unknown>>,
): HttpAuditDescription {
  const action = `${method.toUpperCase()} ${routeUrl}`;
  const segments = routeUrl.split('/').filter((s) => s.length > 0);
  const paramIndex = segments.findIndex((s) => s.startsWith(':'));
  if (paramIndex < 0) return { action, targetType: null, targetId: null };
  const paramName = segments[paramIndex]?.slice(1) ?? '';
  const raw = params[paramName];
  const targetId =
    typeof raw === 'string' && raw.length > 0 ? raw.slice(0, MAX_TARGET_ID_LENGTH) : null;
  const targetType = paramIndex > 0 ? (segments[paramIndex - 1] ?? null) : null;
  return { action, targetType: targetId === null ? null : targetType, targetId };
}
