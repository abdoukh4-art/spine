import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Clock } from '../../../../platform/runtime.js';
import type { AuditStore, AuditWrite } from '../../application/ports.js';
import { describeHttpAction, isMutatingMethod } from '../../domain/audit-policy.js';

/** Who made the request, as recorded in the audit log. */
function actorOf(request: FastifyRequest): Pick<AuditWrite, 'actorId' | 'actorType' | 'details'> {
  const principal = request.principal;
  if (principal?.kind === 'user') return { actorId: principal.id, actorType: 'user' };
  if (principal?.kind === 'webhook') {
    return { actorId: null, actorType: 'webhook', details: { sourceId: principal.sourceId } };
  }
  return { actorId: null, actorType: 'anonymous' };
}

/**
 * Builds the audit entry for a finished request, or null when it must not be audited
 * (reads, CORS preflights, and requests that matched no route, i.e. scanner noise).
 */
export function httpAuditEntry(
  request: FastifyRequest,
  statusCode: number,
  now: Date,
): AuditWrite | null {
  const routeUrl = request.routeOptions.url;
  if (!isMutatingMethod(request.method) || routeUrl === undefined) return null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const { action, targetType, targetId } = describeHttpAction(request.method, routeUrl, params);
  const userAgent = request.headers['user-agent'];
  return {
    occurredAt: now,
    ...actorOf(request),
    action,
    ...(targetType !== null ? { targetType } : {}),
    ...(targetId !== null ? { targetId } : {}),
    outcomeStatus: statusCode,
    requestId: request.id,
    ip: request.ip,
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

/**
 * Root-level `onResponse` hook (ADR-0016, ADR-0064) that records EVERY mutating request of
 * EVERY module, registered through the platform's `SpineModule.httpPlugins` extension point.
 *
 * `onResponse` runs after the response was sent, so the write adds no latency, and it sees
 * the final status code (including 401/403/429 rejections, which are exactly the events an
 * investigator wants). The write is best-effort: a failure is logged at error level and
 * never changes the response the client already received.
 */
export function registerAuditHook(app: FastifyInstance, audit: AuditStore, clock: Clock): void {
  app.addHook('onResponse', async (request, reply) => {
    const entry = httpAuditEntry(request, reply.statusCode, clock.now());
    if (entry === null) return;
    try {
      await audit.append(entry);
    } catch (err) {
      request.log.error({ err, action: entry.action }, 'audit write failed');
    }
  });
}
