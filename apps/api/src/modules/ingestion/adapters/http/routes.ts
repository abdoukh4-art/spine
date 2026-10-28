import {
  BatchQuerySchema,
  BatchResultSchema,
  CanonicalAlertInputSchema,
  IngestResultSchema,
} from '@spine/shared-schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { WebhookSource } from '../../../../platform/config.js';
import {
  NotFoundError,
  OverloadedError,
  UnauthenticatedError,
  ValidationError,
} from '../../../../platform/errors.js';
import { requireUser } from '../../../../platform/http/access.js';
import type { Clock } from '../../../../platform/runtime.js';
import type { BackpressureGuard } from '../../application/backpressure.js';
import type { IngestAlert, IngestOutcome } from '../../application/ingest-alert.js';
import type { IngestBatch } from '../../application/ingest-batch.js';
import { describeNormalizationError } from '../../application/ingest-batch.js';
import {
  isValidIdempotencyKey,
  requestHash,
  userScope,
  webhookScope,
} from '../../domain/idempotency.js';
import { NORMALIZERS } from '../../domain/normalizers/index.js';
import { verifyWebhookSignature } from '../../domain/webhook-signature.js';
import type { IngestionMetrics } from '../metrics.js';

/** Everything the ingestion routes need. */
export interface IngestionRouteDeps {
  ingest: IngestAlert;
  batch: IngestBatch;
  guard: BackpressureGuard;
  metrics: IngestionMetrics;
  clock: Clock;
  webhookSources: Readonly<Record<string, WebhookSource>>;
}

/** 10 MiB: the batch import limit (ADR-0024). */
export const BATCH_BODY_LIMIT = 10 * 1024 * 1024;
const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Ingestion has its own rate-limit bucket (ADR-0024: 6000/min per source), so a busy sensor
 * isn't throttled by the 600/min global API limit, and one noisy source can't starve another.
 * Webhooks are keyed by source id; analyst endpoints by client IP (the user isn't known yet
 * when the limiter runs, in `onRequest`).
 */
export const INGEST_RATE_LIMIT_PER_MINUTE = 6000;
const ingestRateLimit = {
  max: INGEST_RATE_LIMIT_PER_MINUTE,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest) => `ingest:ip:${req.ip}`,
};
const webhookRateLimit = {
  max: INGEST_RATE_LIMIT_PER_MINUTE,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest) => {
    const params = req.params as { sourceId?: unknown } | undefined;
    return `ingest:webhook:${typeof params?.sourceId === 'string' ? params.sourceId : 'unknown'}`;
  },
};

/** Reads and validates the optional `Idempotency-Key` header. */
function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers[IDEMPOTENCY_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isValidIdempotencyKey(value)) {
    throw new ValidationError('invalid Idempotency-Key header', [
      { path: `headers.${IDEMPOTENCY_HEADER}`, message: '1–255 visible ASCII characters' },
    ]);
  }
  return value;
}

function sendOutcome(reply: FastifyReply, outcome: IngestOutcome): FastifyReply {
  if (outcome.kind === 'replay') void reply.header('idempotent-replay', 'true');
  return reply.status(outcome.status).send(outcome.result);
}

/** Looks a webhook source up without touching the prototype chain (`constructor`, `__proto__`). */
function findSource(
  sources: Readonly<Record<string, WebhookSource>>,
  id: string,
): WebhookSource | undefined {
  return Object.hasOwn(sources, id) ? sources[id] : undefined;
}

/**
 * Registers the ingestion endpoints (docs/architecture/api-contract.md#ingestion-module-ingestion).
 * All three share the back-pressure check, which runs in the route's `onRequest` hook: after
 * the global access-control hook (also `onRequest`, ADR-0067) but before the (possibly 10 MiB)
 * body is even read, because shedding load must be cheap (ADR-0034).
 */
export async function registerIngestionRoutes(
  api: FastifyInstance,
  deps: IngestionRouteDeps,
): Promise<void> {
  const shed = async (): Promise<void> => {
    try {
      await deps.guard.check();
    } catch (error) {
      if (error instanceof OverloadedError) deps.metrics.backpressureRejected();
      throw error;
    }
  };

  const app = api.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/alerts',
    {
      onRequest: shed,
      config: { access: { role: 'analyst' }, rateLimit: ingestRateLimit },
      schema: {
        tags: ['ingestion'],
        summary: 'Submit one canonical alert (optional Idempotency-Key header)',
        body: CanonicalAlertInputSchema,
        response: { 202: IngestResultSchema },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const key = idempotencyKey(req);
      const outcome = await deps.ingest.execute({
        alert: req.body,
        ...(key
          ? { idempotency: { scope: userScope(user.id), key, requestHash: requestHash(req.body) } }
          : {}),
      });
      if (outcome.kind === 'fresh') deps.metrics.ingested('api', outcome.result.status);
      return sendOutcome(reply, outcome);
    },
  );

  app.post(
    '/ingest/batch',
    {
      onRequest: shed,
      bodyLimit: BATCH_BODY_LIMIT,
      config: { access: { role: 'analyst' }, rateLimit: ingestRateLimit },
      schema: {
        tags: ['ingestion'],
        summary: 'Bulk import: one record per line (ndjson, cef or suricata-eve); partial success',
        consumes: ['text/plain', 'application/x-ndjson'],
        querystring: BatchQuerySchema,
        body: z.string(),
        response: { 200: BatchResultSchema },
      },
    },
    async (req) => {
      const result = await deps.batch.execute(
        req.body,
        req.query.format,
        deps.clock.now().toISOString(),
      );
      const source = `batch:${req.query.format}`;
      deps.metrics.ingested(source, 'created', result.accepted);
      deps.metrics.ingested(source, 'deduplicated', result.deduplicated);
      deps.metrics.ingested(source, 'rejected', result.rejected);
      return result;
    },
  );

  await api.register((scope, _opts, done) => {
    registerWebhookRoute(scope, deps, shed);
    done();
  });
}

const WebhookParams = z.object({ sourceId: z.string().regex(/^[a-z0-9-]{1,64}$/) });

/**
 * `POST /ingest/webhooks/:sourceId`, in its own encapsulated plugin scope so it can replace
 * the JSON body parser with one that keeps the **raw** body: the HMAC is computed over the
 * exact bytes the sender signed, and re-serializing parsed JSON would not reproduce them.
 */
function registerWebhookRoute(
  scope: FastifyInstance,
  deps: IngestionRouteDeps,
  shed: () => Promise<void>,
): void {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  const app = scope.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/ingest/webhooks/:sourceId',
    {
      onRequest: shed,
      config: { access: 'webhook', rateLimit: webhookRateLimit },
      schema: {
        tags: ['ingestion'],
        summary:
          'Webhook ingestion, authenticated by HMAC-SHA256 (X-Spine-Timestamp, X-Spine-Signature)',
        params: WebhookParams,
        body: z.string(),
        response: { 202: IngestResultSchema },
      },
    },
    async (req, reply) => {
      const { sourceId } = req.params;
      const source = findSource(deps.webhookSources, sourceId);
      // Same problem body as an unmatched route: the response doesn't list or hint at sources.
      if (!source) throw new NotFoundError('Webhook source', sourceId);
      authenticateWebhook(req, req.body, source, deps, sourceId);
      const key = idempotencyKey(req);
      const metricSource = `webhook:${sourceId}`;
      const normalized = NORMALIZERS[source.normalizer](req.body, {
        receivedAt: deps.clock.now().toISOString(),
      });
      if (!normalized.ok) {
        deps.metrics.ingested(metricSource, 'rejected');
        throw new ValidationError(
          describeNormalizationError(normalized.error),
          normalized.error.issues?.map((i) => ({ path: `body.${i.path}`, message: i.message })),
        );
      }
      const outcome = await deps.ingest.execute({
        alert: normalized.value,
        ...(key
          ? {
              idempotency: {
                scope: webhookScope(sourceId),
                key,
                requestHash: requestHash(req.body),
              },
            }
          : {}),
      });
      if (outcome.kind === 'fresh') deps.metrics.ingested(metricSource, outcome.result.status);
      return sendOutcome(reply, outcome);
    },
  );
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function authenticateWebhook(
  req: FastifyRequest,
  rawBody: string,
  source: WebhookSource,
  deps: IngestionRouteDeps,
  sourceId: string,
): void {
  const failure = verifyWebhookSignature({
    secret: source.secret,
    timestampHeader: header(req, 'x-spine-timestamp'),
    signatureHeader: header(req, 'x-spine-signature'),
    rawBody,
    nowMs: deps.clock.now().getTime(),
  });
  if (failure) {
    // The reason goes to the log (never the secret); the client only learns "401".
    req.log.warn({ sourceId, reason: failure }, 'webhook signature rejected');
    throw new UnauthenticatedError('invalid webhook signature');
  }
  req.principal = { kind: 'webhook', sourceId };
}
